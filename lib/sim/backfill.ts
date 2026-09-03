/**
 * The two backfill executors: `BackfillExecutor` (the sync-queue one) and
 * `RetypeBackfillExecutor` (the promotion one).
 *
 * They look similar and answer different questions. The first is repairing
 * **one entry** whose write outran its index: the payload landed, a filterable
 * field had no slot, and now one does. The second is repairing **one field**
 * across every entry in the model, because the field only just became
 * filterable at all.
 *
 * Both are pure. Neither mutates the world — each returns the slot values it
 * would write, and the caller applies them inside whatever transaction it owns.
 * That is what makes a whole-chunk rollback a matter of dropping a value rather
 * than undoing one.
 */

import type { DeclaredType, SimEntry } from './types';
import {
  canonicalise,
  coerceForSlot,
  loadLiveSlotMap,
  splitPayload,
} from './write';
import type { SimWorld } from './world';

/* ------------------------------------------------------------------ *
 * BackfillExecutor — the sync-queue path
 * ------------------------------------------------------------------ */

export interface BackfillResult {
  entryId: number;
  /** pageId → column → value, ready to merge onto the entry's slot mirror. */
  slotWrites: Record<number, Record<string, unknown>>;
  /**
   * Filterable fields that *still* have no live slot.
   *
   * Non-empty is the ADR 0007 condition: the chunk cannot complete, so it rolls
   * back whole and the caller tries to reserve. The queue rows stay claimable.
   */
  stillUnmapped: string[];
}

export type BackfillOutcome =
  | { ok: true; result: BackfillResult }
  /** `UncoercibleSlotValueException` — routes the row to the DLQ. */
  | { ok: false; reason: 'schema_incompatibility'; error: string }
  /** `EntryDataMissingException` — the DLQ reason that outlives its own row. */
  | { ok: false; reason: 'missing_entry_data'; error: string };

/**
 * `BackfillExecutor::backfill($entryId)`.
 *
 * It re-runs the *same* splitter the write path ran, against a registry that
 * has since changed. That is the whole trick: nothing about the entry is
 * special-cased, the map simply has a slot in it now where it did not before.
 *
 * Note there is no `deleted_at` predicate. A soft-deleted entry is backfilled
 * like any other — the engine selects it by id and asks no further questions,
 * and mirroring a value into a column nobody will read costs nothing next to
 * leaving a queue row that never drains.
 *
 * **Coercion happens here for the first time.** The write path drops a
 * filterable-but-unmapped field before it ever coerces, so a value the column
 * cannot hold — `"abc"` written to a JSON-only `int` field — is accepted at
 * write time and only refused now, which is exactly when the DLQ exists to
 * catch it.
 */
export function backfillEntry(world: SimWorld, entryId: number): BackfillOutcome {
  const entry = world.entries.find(e => e.id === entryId);
  if (entry === undefined) {
    return {
      ok: false,
      reason: 'missing_entry_data',
      error: `EntryDataMissingException: entry ${entryId} no longer exists.`,
    };
  }

  const map = loadLiveSlotMap(world, entry.modelId);
  const split = splitPayload(map, canonicalise(map, entry.fields));

  if (!split.ok) {
    return { ok: false, reason: 'schema_incompatibility', error: split.error };
  }

  return {
    ok: true,
    result: {
      entryId,
      slotWrites: split.plan.slotWrites,
      stillUnmapped: split.plan.missingSlotFields,
    },
  };
}

/** Merge a backfill's slot writes onto an entry's mirror, without mutating it. */
export function applySlotWrites(
  entry: SimEntry,
  slotWrites: Record<number, Record<string, unknown>>,
): SimEntry {
  const slots: SimEntry['slots'] = { ...entry.slots };
  for (const [pageId, columns] of Object.entries(slotWrites)) {
    const id = Number(pageId);
    slots[id] = { ...slots[id], ...columns };
  }
  return { ...entry, slots };
}

/* ------------------------------------------------------------------ *
 * RetypeBackfillExecutor — the promotion path
 * ------------------------------------------------------------------ */

/** The closed reason taxonomy a failed coercion is annotated with. */
export type CoercionNullReason =
  | 'out_of_range'
  | 'non_integer'
  | 'malformed_datetime'
  | 'malformed_number'
  /** A pair the matrix refuses outright — `int↔datetime`, `numeric↔datetime`. */
  | 'epoch_coercion_rejected'
  | 'unparseable';

export type IdentityCoercion =
  /** A value to write into the slot column. */
  | { kind: 'coerced'; value: unknown }
  /**
   * The JSON key was absent, or its value was JSON `null`.
   *
   * **No event fires for this.** Nothing was attempted, so there is nothing to
   * report — an absent key is not a failure, it is a row that never had the
   * field. Logging it would bury the real failures under a line per row.
   */
  | { kind: 'not_attempted' }
  /** Attempted and refused. The slot is written NULL and an event fires. */
  | { kind: 'null_coerced'; reason: CoercionNullReason };

/**
 * `RetypeCoercionEngine::isCategoricallyRejected()` — the four cells the matrix
 * refuses outright.
 *
 * `int↔datetime` and `numeric↔datetime`. There is no defensible answer to "what
 * integer is this timestamp": seconds since the epoch, milliseconds, a
 * `YYYYMMDD` packed date and a Julian day are all defensible and all different,
 * so the matrix declines rather than choosing one silently. The initiator
 * consults this *before* any registry mutation and refuses the retype outright;
 * this function reaching the executor at all would mean a stale checkpoint.
 */
export function isCategoricallyRejected(from: DeclaredType, to: DeclaredType): boolean {
  return (
    ((from === 'int' || from === 'numeric') && to === 'datetime') ||
    (from === 'datetime' && (to === 'int' || to === 'numeric'))
  );
}

/**
 * The ADR 0024 coercion matrix — all sixteen cells.
 *
 * Four identity diagonals, eight coercible off-diagonals, four categorical
 * refusals. This started as the diagonal alone, because a *promotion* changes no
 * declared type and every cell it can reach is on it; the rest arrived with
 * `retypeField()`.
 *
 * **It is deliberately not `coerceForSlot()`**, and the engine says so in its
 * own docblock: the write path's coercion is *stricter*, because a caller
 * supplying a payload is expected to have it in the target shape already and
 * gets an exception when they do not. This is repair work over data that was
 * written under a different type, so it converts where it defensibly can and
 * writes NULL with an audited reason where it cannot. Same values, two different
 * jobs, two different answers — and using the write path's rules here was the
 * shortcut the diagonal took, which showed up as the wrong `reason` on the
 * event rather than as a wrong value.
 *
 * Three states, and the middle one is easy to get wrong: `not_attempted` means
 * the key was absent **or** its value was JSON null. It suppresses the *event*,
 * not the write — the slot is still written NULL, unconditionally, because
 * skipping it leaves the partition unevenly materialised and the page table
 * missing rows the Liberator's sweep counts.
 */
export function coerceForRetype(
  fields: Record<string, unknown>,
  fieldName: string,
  from: DeclaredType,
  to: DeclaredType,
): IdentityCoercion {
  if (!(fieldName in fields)) return { kind: 'not_attempted' };

  const value = fields[fieldName];
  if (value === null) return { kind: 'not_attempted' };

  // Defensive. The initiator refuses these before writing anything, so reaching
  // here means a checkpoint outlived the rules that opened it.
  if (isCategoricallyRejected(from, to)) {
    return { kind: 'null_coerced', reason: 'epoch_coercion_rejected' };
  }

  if (from === to) return identity(value, to);

  if (from === 'string' && to === 'int') return stringToInt(value);
  if (from === 'string' && to === 'numeric') return stringToNumeric(value);
  if (from === 'string' && to === 'datetime') return stringToDatetime(value);
  if (from === 'int' && to === 'string') return intToString(value);
  if (from === 'int' && to === 'numeric') return intToNumeric(value);
  if (from === 'numeric' && to === 'string') return numericToString(value);
  if (from === 'numeric' && to === 'int') return numericToInt(value);
  if (from === 'datetime' && to === 'string') return datetimeToString(value);

  return { kind: 'null_coerced', reason: 'unparseable' };
}

/**
 * The identity diagonal — a pure copy, with one exception.
 *
 * `datetime` is renormalised to the slot's `Y-m-d H:i:s` UTC form rather than
 * passed through, because the payload may carry an offset the column cannot.
 * The other three accept the stored value and fall back to the string parser
 * when the JSON type does not match the declared one, which is legal: the
 * payload keeps the raw value and only the slot column is coerced, so
 * `{"qty": "42"}` on an `int` field is an ordinary row rather than a defect.
 */
function identity(value: unknown, type: DeclaredType): IdentityCoercion {
  switch (type) {
    case 'string':
      return typeof value === 'object'
        ? { kind: 'null_coerced', reason: 'unparseable' }
        : { kind: 'coerced', value: phpString(value) };
    case 'int':
      return typeof value === 'number' && Number.isInteger(value)
        ? { kind: 'coerced', value }
        : stringToInt(typeof value === 'string' ? value : phpString(value));
    case 'numeric':
      return typeof value === 'number'
        ? { kind: 'coerced', value }
        : stringToNumeric(typeof value === 'string' ? value : phpString(value));
    case 'datetime':
      return typeof value === 'string'
        ? reformatForSlot(value)
        : { kind: 'null_coerced', reason: 'malformed_datetime' };
  }
}

/** PHP's `(string)` cast: `true` is `"1"` and `false` is the empty string. */
function phpString(value: unknown): string {
  if (typeof value === 'boolean') return value ? '1' : '';
  return String(value);
}

/**
 * string → int. A base-10 literal and nothing else: optional leading `-`,
 * digits, no whitespace, no decimals, no separators, no leading `+`. The
 * round-trip check is what rejects `007`, `-0` and BIGINT overflow, and it is
 * done in `BigInt` because `Number` loses integer precision above 2^53 and
 * would reject `9223372036854775807` — a value MySQL takes.
 */
function stringToInt(value: unknown): IdentityCoercion {
  if (typeof value !== 'string') return { kind: 'null_coerced', reason: 'unparseable' };
  if (!/^-?[0-9]+$/.test(value)) return { kind: 'null_coerced', reason: 'unparseable' };

  const asBig = BigInt(value);
  if (asBig < BIGINT_MIN || asBig > BIGINT_MAX || asBig.toString() !== value) {
    return { kind: 'null_coerced', reason: 'out_of_range' };
  }
  return { kind: 'coerced', value: Number(asBig) };
}

/**
 * string → numeric. The **JSON number grammar** (RFC 8259 §6), which is
 * markedly narrower than the write path's `is_numeric()`: no leading `+`, no
 * surrounding whitespace, no bare `.5` or trailing `5.`, no `NaN`, no
 * `Infinity`. Two rules for two jobs, again.
 */
function stringToNumeric(value: unknown): IdentityCoercion {
  if (typeof value !== 'string') return { kind: 'null_coerced', reason: 'malformed_number' };
  if (!JSON_NUMBER.test(value)) return { kind: 'null_coerced', reason: 'malformed_number' };

  const f = Number(value);
  if (!Number.isFinite(f)) return { kind: 'null_coerced', reason: 'out_of_range' };
  return { kind: 'coerced', value: f };
}

/**
 * string → datetime. Strict RFC 3339 **with an explicit offset** — a naive
 * datetime is refused, because there is no server timezone to read it in.
 * Normalised to UTC and truncated to the column's second precision.
 */
function stringToDatetime(value: unknown): IdentityCoercion {
  if (typeof value !== 'string') return { kind: 'null_coerced', reason: 'malformed_datetime' };
  if (!RFC3339_WITH_OFFSET.test(value)) {
    return { kind: 'null_coerced', reason: 'malformed_datetime' };
  }
  return reformatForSlot(value);
}

function intToString(value: unknown): IdentityCoercion {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return { kind: 'coerced', value: String(value) };
  }
  // Defensive: a JSON numeric *string* under an `int` declared type, which the
  // payload is allowed to hold.
  const asInt = stringToInt(value);
  return asInt.kind === 'coerced'
    ? { kind: 'coerced', value: String(asInt.value) }
    : asInt.kind === 'null_coerced' && asInt.reason === 'out_of_range'
      ? asInt
      : { kind: 'null_coerced', reason: 'unparseable' };
}

/** int → numeric. Lossless widening; `int` is a subset of `numeric`. */
function intToNumeric(value: unknown): IdentityCoercion {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return { kind: 'coerced', value };
  }
  const asInt = stringToInt(value);
  return asInt.kind === 'coerced'
    ? { kind: 'coerced', value: Number(asInt.value) }
    : asInt.kind === 'null_coerced' && asInt.reason === 'out_of_range'
      ? asInt
      : { kind: 'null_coerced', reason: 'unparseable' };
}

/**
 * numeric → string. Canonical decimal: shortest round-tripping form, never
 * scientific notation, trailing zeros trimmed, `-0` normalised to `0`.
 */
function numericToString(value: unknown): IdentityCoercion {
  const f = extractFloat(value);
  if (f === null) return { kind: 'null_coerced', reason: 'malformed_number' };
  if (f === 0) return { kind: 'coerced', value: '0' };
  return { kind: 'coerced', value: canonicalFloatString(f) };
}

/**
 * numeric → int. Only when integer-valued and in range. **No truncation and no
 * rounding** — `2.5` becomes NULL with `non_integer` rather than `2`, because a
 * silent rounding here would be a wrong value in an index nobody could audit.
 */
function numericToInt(value: unknown): IdentityCoercion {
  const f = extractFloat(value);
  if (f === null) return { kind: 'null_coerced', reason: 'malformed_number' };
  if (Math.floor(f) !== f) return { kind: 'null_coerced', reason: 'non_integer' };
  if (f < Number(BIGINT_MIN) || f > Number(BIGINT_MAX)) {
    return { kind: 'null_coerced', reason: 'out_of_range' };
  }
  return { kind: 'coerced', value: f };
}

/**
 * datetime → string. RFC 3339 in UTC with a `Z` suffix, not `+00:00`, and with
 * `.000000` microseconds for canonical fidelity even though the slot drops
 * them. A stored datetime comes through the payload as `Y-m-d H:i:s` with no
 * offset, and the column's convention says that is UTC.
 */
function datetimeToString(value: unknown): IdentityCoercion {
  if (typeof value !== 'string') return { kind: 'null_coerced', reason: 'malformed_datetime' };
  const parsed = parseAsUtc(value);
  if (parsed === null) return { kind: 'null_coerced', reason: 'malformed_datetime' };
  return { kind: 'coerced', value: `${parsed.toISOString().slice(0, 19)}.000000Z` };
}

function reformatForSlot(value: string): IdentityCoercion {
  const parsed = parseAsUtc(value);
  if (parsed === null) return { kind: 'null_coerced', reason: 'malformed_datetime' };
  return { kind: 'coerced', value: parsed.toISOString().slice(0, 19).replace('T', ' ') };
}

/** Parse, treating a value with no offset as UTC rather than as local time. */
function parseAsUtc(value: string): Date | null {
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(value);
  const normalised = hasOffset ? value.replace(' ', 'T') : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalised);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function extractFloat(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && JSON_NUMBER.test(value)) {
    const f = Number(value);
    return Number.isFinite(f) ? f : null;
  }
  return null;
}

/**
 * The shortest representation that round-trips, in fixed notation.
 *
 * JavaScript's `String(f)` already gives the shortest round-trip form — the
 * same thing PHP's `serialize_precision = -1` produces — so the only work is
 * expanding the exponential form it switches to at the extremes.
 * `toFixed` cannot do it above 1e21, where it returns exponential notation
 * itself; such a value is necessarily integral, so `BigInt` expands it exactly.
 */
function canonicalFloatString(f: number): string {
  const plain = String(f);
  if (!plain.includes('e') && !plain.includes('E')) {
    return plain.includes('.') ? plain.replace(/0+$/, '').replace(/\.$/, '') : plain;
  }
  if (Math.abs(f) >= 1e21) return BigInt(f).toString();
  const fixed = f.toFixed(14).replace(/0+$/, '').replace(/\.$/, '');
  return fixed === '' || fixed === '-' ? '0' : fixed;
}

/** The signed BIGINT bounds — `PHP_INT_MIN` / `PHP_INT_MAX` on a 64-bit host. */
const BIGINT_MIN = -(2n ** 63n);
const BIGINT_MAX = 2n ** 63n - 1n;

/** RFC 8259 §6, exactly. Narrower than PHP's `is_numeric()` on purpose. */
const JSON_NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

/** RFC 3339 with a mandatory offset. A space separator is allowed per §5.6. */
const RFC3339_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
