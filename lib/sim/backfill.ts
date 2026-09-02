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
 * The ADR 0024 coercion matrix, **identity diagonal only**.
 *
 * A promotion changes no declared type, so every cell it can reach is on the
 * diagonal and the coercion is the plain "does this value fit the column"
 * question the write path already answers. The off-diagonal cells — `int` to
 * `string`, `string` to `datetime`, the two categorical refusals — belong to
 * `retypeField()`, which is the schema-change section's job. Building them here
 * would be building that section early against no caller.
 *
 * The reason is derived from the target type rather than from the error text.
 * Parsing a message to classify a failure is the kind of coupling that breaks
 * silently when the message is reworded.
 */
export function identityCoerce(
  fields: Record<string, unknown>,
  fieldName: string,
  declaredType: DeclaredType,
): IdentityCoercion {
  if (!(fieldName in fields)) return { kind: 'not_attempted' };

  const value = fields[fieldName];
  if (value === null) return { kind: 'not_attempted' };

  const coerced = coerceForSlot(value, declaredType, fieldName);
  if (coerced.ok) return { kind: 'coerced', value: coerced.value };

  return { kind: 'null_coerced', reason: reasonFor(value, declaredType) };
}

function reasonFor(value: unknown, declaredType: DeclaredType): CoercionNullReason {
  switch (declaredType) {
    case 'int':
      // An integer-shaped string that still failed can only have overflowed
      // BIGINT; anything else was not an integer to begin with.
      return typeof value === 'string' && /^-?\d+$/.test(value)
        ? 'out_of_range'
        : 'non_integer';
    case 'numeric':
      return 'malformed_number';
    case 'datetime':
      return 'malformed_datetime';
    case 'string':
      // The only way a scalar fails to become a string is the 4096-character
      // bound; a non-scalar never had a string in it.
      return typeof value === 'object' ? 'unparseable' : 'out_of_range';
  }
}
