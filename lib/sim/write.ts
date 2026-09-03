/**
 * The write path — `EntryWriter`, `LiveSlotMap` and `PayloadSplitter`, simulated.
 *
 * Written against `src/Write/` in the engine repo. The whole subsystem exists
 * to keep one promise, ADR 0007's: **a write never fails because indexing is
 * behind.** The payload lands in `entry_data.fields` in full, always; mirroring
 * it into a typed slot column is a separate, best-effort step, and when it
 * cannot happen the entry is queued for a daemon to catch up on rather than
 * refused.
 *
 * Four rules here are easy to get subtly wrong, and each of them is a lesson
 * the playground is built to teach rather than an implementation detail:
 *
 *   1. **`entry_data.fields` holds the RAW value; coercion touches only the
 *      slot column.** Writing `{"qty": "42"}` against `declared_type = int`
 *      persists the JSON string `"42"` and the slot integer `42`. The two
 *      legitimately disagree, and "fixing" the JSON to look coerced would
 *      teach the opposite of ADR 0013.
 *   2. **Filterability is checked BEFORE the live-slot lookup, and the lookup
 *      is total.** An unknown key and a registered-but-JSON-only field are
 *      both dropped from the slot plan and neither ever enqueues. Inverting
 *      the two checks routes a JSON-only field into the exhaustion queue,
 *      where no reservation can ever satisfy it.
 *   3. **One `stardust_sync_queue` row per write**, not one per unmapped
 *      field, and the table has no dedupe key — so writing the same entry
 *      twice appends two rows.
 *   4. **Live means `assigned | backfilling | ready`.** A `tombstoned` slot is
 *      not live, so a field mid-tombstone behaves exactly like one that never
 *      had a slot: enqueue.
 *
 * Everything here is pure. A rejected write returns the *original* world with
 * an error string — there is no transaction to roll back, because the function
 * returning the world unchanged is what a rollback amounts to.
 */

import { emit } from './emit';
import { line } from './events';
import type { PayloadRow, SimPayloadDraft } from './payload';
import type { DeclaredType, SimEntry, SimSyncRow, SlotStatus } from './types';
import { fieldsOf, liveSlotForField, simNow, type SimWorld } from './world';

/** `EntryPayload::$fields` — keyed by field name, values untyped. */
export type PayloadFields = Record<string, unknown>;

/**
 * `FilterLimits::DEFAULT_MAX_STRING_LENGTH`.
 *
 * The write bound is deliberately the same number as the filter bound: a
 * filterable string slot is a `TEXT` column sized for exactly this, so a
 * longer value would raise a raw MySQL 1406 at the UPSERT. The engine guards
 * it before any SQL so the failure is typed, and measures it in UTF-8
 * characters rather than bytes.
 */
export const MAX_FILTERABLE_STRING_LENGTH = 4096;

/* ------------------------------------------------------------------ *
 * LiveSlotMap
 * ------------------------------------------------------------------ */

/** One field that currently holds a live slot. */
export interface LiveSlotEntry {
  fieldId: number;
  fieldName: string;
  declaredType: DeclaredType;
  slotColumn: string;
  pageId: number;
  status: SlotStatus;
}

/**
 * A snapshot of one model's registry, as the write path needs it.
 *
 * `filterability` is separate from `byFieldName` on purpose, and carries
 * *every* registered field rather than only the slotted ones. That is what
 * lets the splitter tell three cases apart — unknown key, JSON-only field,
 * and filterable-but-unmapped field — which otherwise all look identical as
 * "no entry in the map".
 */
export interface LiveSlotMap {
  byFieldName: Record<string, LiveSlotEntry>;
  /** Registered field name → `is_filterable`. */
  filterability: Record<string, boolean>;
  /** ADR 0036: old field name → current name, while a rename is in flight. */
  canonicalByPreviousName: Record<string, string>;
  /** ADR 0037: fields whose deletion is in flight. Severed from the maps above. */
  pendingDeletionNames: string[];
  /** ADR 0038. Not derivable from the maps being empty — a fieldless model is legal. */
  modelDeleted: boolean;
}

export function loadLiveSlotMap(world: SimWorld, modelId: number): LiveSlotMap {
  const model = world.models.find(m => m.id === modelId);

  const map: LiveSlotMap = {
    byFieldName: {},
    filterability: {},
    canonicalByPreviousName: {},
    pendingDeletionNames: [],
    // A model with no registry row must read `false`, not `true`: absent is
    // not deleting. Every guard in the engine tests the marker positively for
    // exactly this reason.
    modelDeleted: model !== undefined && model.deletedAt !== null,
  };

  // Deliberately not `fieldsOf()`, which filters deleted fields out. The
  // splitter needs to know a field is mid-deletion so it can strip the key
  // rather than treat it as unknown — see `canonicalise()`.
  for (const field of world.fields.filter(f => f.modelId === modelId)) {
    if (field.deletedAt !== null) {
      map.pendingDeletionNames.push(field.name);
      continue;
    }

    map.filterability[field.name] = field.isFilterable;

    if (field.previousName !== null) {
      map.canonicalByPreviousName[field.previousName] = field.name;
    }

    const slot = liveSlotForField(world, field.id);
    if (slot === undefined) continue;

    map.byFieldName[field.name] = {
      fieldId: field.id,
      fieldName: field.name,
      declaredType: field.declaredType,
      slotColumn: slot.slotColumn,
      pageId: slot.pageId,
      status: slot.status,
    };
  }

  return map;
}

/**
 * `LiveSlotMap::isFilterable()` — **total**. An unknown name returns `false`.
 *
 * That totality is what lets one predicate cover both silently-dropped
 * categories. It is not a convenience: a lookup that distinguished "unknown"
 * from "known and not filterable" would tempt a caller into treating the first
 * as an error, and an unknown key is not an error — its value is preserved.
 */
export function isFilterable(map: LiveSlotMap, name: string): boolean {
  return map.filterability[name] ?? false;
}

/**
 * The two gates the engine puts in front of `canonicalise()`, so the steady
 * state is a pair of `false` checks rather than a payload rewrite.
 *
 * Module-private: nothing outside needs to ask, and the schema-change section
 * that eventually will can export them then.
 */
function hasAliases(map: LiveSlotMap): boolean {
  return Object.keys(map.canonicalByPreviousName).length > 0;
}

function hasPendingDeletions(map: LiveSlotMap): boolean {
  return map.pendingDeletionNames.length > 0;
}

/**
 * Rewrite inbound keys onto the registry's current names, and drop keys naming
 * a field whose deletion is in flight.
 *
 * **This runs before the payload is stored, not merely before it is planned.**
 * The canonicalised payload is what gets persisted. A rename flips the field
 * name immediately, so a client that has not redeployed keeps sending the old
 * key; leaving it un-rewritten would store the value under a stale key that
 * the rename backfill has already swept past, and the value would disappear
 * for good when the bridge marker is cleared.
 *
 * Stripping a deleting field's key is the same argument inverted: an
 * unregistered key's value is *preserved*, so merely leaving the field out of
 * the map would let a client keep writing values back into rows the purge has
 * already passed — the field's data would outlive the field indefinitely.
 *
 * Nothing sets either marker before the schema-change section, so this is two
 * `false` checks in the steady state. The predicate is the behaviour, though,
 * not the current state.
 */
export function canonicalise(map: LiveSlotMap, fields: PayloadFields): PayloadFields {
  if (!hasAliases(map) && !hasPendingDeletions(map)) return fields;

  const out: PayloadFields = { ...fields };

  // Renames first, deletions second — matching the engine's order.
  for (const [previous, current] of Object.entries(map.canonicalByPreviousName)) {
    if (!(previous in out)) continue;
    // The current name wins a collision: a client sending both keys is
    // mid-migration, and the new one is the one it means.
    if (!(current in out)) out[current] = out[previous];
    delete out[previous];
  }

  for (const name of map.pendingDeletionNames) {
    delete out[name];
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Coercion
 * ------------------------------------------------------------------ */

export type CoercionResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * `Y-m-d H:i:s` and ISO 8601, and deliberately nothing else.
 *
 * **This is narrower than the engine, on purpose.** The engine hands the value
 * to PHP's `DateTimeImmutable` constructor, which also accepts `now`,
 * `tomorrow`, `+1 day` and a great deal else, and which reads a string with no
 * offset in the *server's* timezone before converting to UTC. Reproducing that
 * in a browser would mean guessing at a server configuration and rendering the
 * guess as fact, so the simulation accepts a documented subset and the page
 * says so rather than implying a bound the engine does not have.
 */
const ISO_LIKE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * The Phase 3 first-write coercion policy.
 *
 * Distinct from the retype-backfill matrix, which is a different set of rules
 * for a different job. Note the whole function is unreachable until a page has
 * been provisioned and a slot reserved — the splitter drops every field before
 * this point while the model has no live slots. It is written complete anyway,
 * because splitting the splitter in half would mean rewriting it rather than
 * reusing it once the daemons land, and because the engine's own
 * `PayloadSplitter` is one unit.
 */
export function coerceForSlot(
  value: unknown,
  declaredType: DeclaredType,
  fieldName: string,
): CoercionResult {
  // NULL passes through for every declared type, with no validation at all.
  if (value === null) return { ok: true, value: null };

  switch (declaredType) {
    case 'string':
      return coerceString(value, fieldName);
    case 'int':
      return coerceInt(value, fieldName);
    case 'numeric':
      return coerceNumeric(value, fieldName);
    case 'datetime':
      return coerceDatetime(value, fieldName);
  }
}

/**
 * PHP's `get_debug_type()`, approximated.
 *
 * The engine puts this in its exception messages and those messages are
 * reproduced here verbatim, so the type names have to match. The one place
 * the approximation shows is that PHP has `int` and `float` where JavaScript
 * has one `number`; splitting on `Number.isInteger` is the honest guess and
 * gives the right answer for every value a payload form can produce.
 *
 * Exported because the filter pre-flight puts the same function's output in
 * *its* messages. Copying it would be the drift `emit()` was moved out of this
 * file to prevent — one rule, one place, even when the rule is four lines.
 */
export function debugType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'boolean':
      return 'bool';
    case 'number':
      return Number.isInteger(value) ? 'int' : 'float';
    default:
      return typeof value;
  }
}

function coerceString(value: unknown, fieldName: string): CoercionResult {
  let str: string;
  if (typeof value === 'string') {
    str = value;
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    // PHP's `(string)` cast, which is what the engine uses: `true` is "1" and
    // `false` is the empty string.
    str = typeof value === 'boolean' ? (value ? '1' : '') : String(value);
  } else {
    return {
      ok: false,
      error: `Field '${fieldName}': cannot coerce ${debugType(value)} to string.`,
    };
  }

  // Counted in characters rather than UTF-16 code units, matching the engine's
  // `mb_strlen`. `[...str]` iterates code points, which is the same count for
  // every value this bound can plausibly be hit with.
  const length = [...str].length;
  if (length > MAX_FILTERABLE_STRING_LENGTH) {
    return {
      ok: false,
      error:
        `Field '${fieldName}': string value of length ${length} exceeds the ` +
        `maximum filterable string length of ${MAX_FILTERABLE_STRING_LENGTH} characters.`,
    };
  }

  return { ok: true, value: str };
}

/** The signed BIGINT bounds — `PHP_INT_MIN` / `PHP_INT_MAX` on a 64-bit host. */
const BIGINT_MIN = -(2n ** 63n);
const BIGINT_MAX = 2n ** 63n - 1n;

function coerceInt(value: unknown, fieldName: string): CoercionResult {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      return {
        ok: false,
        error: `Field '${fieldName}': float ${value} cannot be losslessly coerced to BIGINT.`,
      };
    }
    return { ok: true, value };
  }

  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    // The engine requires the string to survive a round-trip through an int
    // cast, which rejects BIGINT overflow and — as a side effect it does not
    // advertise — also rejects '007', '-0' and '+5'.
    //
    // Compared with BigInt rather than Number, because Number loses integer
    // precision above 2^53 and would reject '9223372036854775807', which is a
    // perfectly valid BIGINT the engine accepts. Getting the accept/reject
    // boundary wrong on a value the engine takes is the kind of quiet lie this
    // whole module exists to avoid.
    const asBig = BigInt(value);
    if (asBig < BIGINT_MIN || asBig > BIGINT_MAX || asBig.toString() !== value) {
      return {
        ok: false,
        error: `Field '${fieldName}': integer string '${value}' overflows BIGINT.`,
      };
    }
    // Stored as a Number so the world stays JSON-serialisable for the snapshot;
    // above 2^53 that loses precision MySQL would have kept. Unreachable from a
    // payload form, and a browser limitation rather than an engine one.
    return { ok: true, value: Number(asBig) };
  }

  return {
    ok: false,
    error: `Field '${fieldName}': cannot coerce ${debugType(value)} to int.`,
  };
}

/**
 * PHP's `is_numeric()`, as a pattern.
 *
 * Deliberately **not** `Number.isFinite(Number(v))`, which is the obvious port
 * and is wrong: JavaScript's numeric conversion also accepts `0x1A` (26) and
 * `0b101` (5), both of which `is_numeric()` rejects — so the obvious version
 * writes a value into a `DOUBLE` slot on a payload MySQL would never have
 * received. Verified against PHP 8.4: `' 1.5'`, `'1.5 '`, `'1e3'`, `'.5'`,
 * `'5.'`, `'+3'` and `'-0'` are numeric; `'0x1A'`, `'0b101'`, `'1_000'`,
 * `'Infinity'` and whitespace alone are not.
 */
const PHP_NUMERIC = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;

function coerceNumeric(value: unknown, fieldName: string): CoercionResult {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { ok: true, value };
  }
  // Booleans are rejected, which is the other reason not to reach for
  // `Number()` alone: `Number(true)` is 1 and PHP would have thrown.
  if (typeof value === 'string' && PHP_NUMERIC.test(value)) {
    return { ok: true, value: Number(value) };
  }
  return {
    ok: false,
    error: `Field '${fieldName}': cannot coerce ${debugType(value)} to numeric.`,
  };
}

function coerceDatetime(value: unknown, fieldName: string): CoercionResult {
  if (typeof value !== 'string' || value === '') {
    return {
      ok: false,
      error: `Field '${fieldName}': cannot coerce ${debugType(value)} to datetime.`,
    };
  }
  if (!ISO_LIKE.test(value)) {
    return {
      ok: false,
      error:
        `Field '${fieldName}': cannot parse '${value}' as datetime. ` +
        `This simulation accepts 'Y-m-d H:i:s' and ISO 8601 only; the engine is more permissive.`,
    };
  }

  // A bare date or a naked local time is read as UTC here. The engine would
  // read the second in the server's timezone — see ISO_LIKE's note.
  const normalised = value.includes('T') || /[Z+]/.test(value.slice(10))
    ? value
    : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalised);
  if (Number.isNaN(parsed.getTime())) {
    return {
      ok: false,
      error: `Field '${fieldName}': cannot parse '${value}' as datetime.`,
    };
  }

  return { ok: true, value: parsed.toISOString().slice(0, 19).replace('T', ' ') };
}

/* ------------------------------------------------------------------ *
 * PayloadSplitter
 * ------------------------------------------------------------------ */

export interface SplitPlan {
  /** pageId → slot column → coerced value, ready for the per-page UPSERT. */
  slotWrites: Record<number, Record<string, unknown>>;
  /** Registered, filterable fields with no live slot. ADR 0007. */
  missingSlotFields: string[];
  /** Registered but `is_filterable = 0`. JSON-only, and never enqueued. */
  jsonOnlyFields: string[];
  /** Not in `stardust_fields` for this model. Preserved verbatim in the JSON. */
  unknownKeys: string[];
}

export type SplitOutcome =
  | { ok: true; plan: SplitPlan }
  | { ok: false; error: string };

/**
 * Map a payload onto a per-page write plan.
 *
 * `jsonOnlyFields` and `unknownKeys` are ours, not the engine's — it has no
 * use for either, since both are silent drops. The playground does: they are
 * the difference between "this value is safely stored and will never be
 * indexed, by design" and "this value is safely stored and a daemon is coming
 * for it", and a section that showed both as "not indexed" would flatten the
 * most important distinction on the page.
 */
export function splitPayload(map: LiveSlotMap, fields: PayloadFields): SplitOutcome {
  const plan: SplitPlan = {
    slotWrites: {},
    missingSlotFields: [],
    jsonOnlyFields: [],
    unknownKeys: [],
  };

  for (const [name, value] of Object.entries(fields)) {
    // ORDER IS LOAD-BEARING. Filterability is checked before the slot lookup,
    // so a JSON-only field can never reach `missingSlotFields` — there is no
    // reservation that would ever satisfy it, and a queue entry waiting on one
    // would never drain.
    if (!isFilterable(map, name)) {
      if (name in map.filterability) plan.jsonOnlyFields.push(name);
      else plan.unknownKeys.push(name);
      continue;
    }

    const entry = map.byFieldName[name];
    if (entry === undefined) {
      plan.missingSlotFields.push(name);
      continue;
    }

    const coerced = coerceForSlot(value, entry.declaredType, entry.fieldName);
    if (!coerced.ok) return { ok: false, error: coerced.error };

    plan.slotWrites[entry.pageId] ??= {};
    plan.slotWrites[entry.pageId][entry.slotColumn] = coerced.value;
  }

  return { ok: true, plan };
}

/* ------------------------------------------------------------------ *
 * EntryWriter
 * ------------------------------------------------------------------ */

export interface SlotWriteRef {
  pageId: number;
  slotColumn: string;
  /**
   * Not on the engine's `EntryWriteResult`, which carries only the page and
   * the column — it has no presenter to serve. Added here because a section
   * that draws a value moving into a slot has to be able to say *which* value,
   * and deriving the name back from the column would mean re-reading the
   * registry to answer a question the splitter already knew the answer to.
   */
  fieldName: string;
}

/**
 * `EntryWriteResult`, plus the three drop categories.
 *
 * `enqueuedForBackfill` being `true` is not a failure. It is the ADR 0007
 * guarantee working: the entry is committed and complete, and a row now sits
 * in `stardust_sync_queue` for the Reconciler.
 */
export interface EntryWriteOutcome {
  entryId: number;
  enqueuedForBackfill: boolean;
  slotsWritten: SlotWriteRef[];
  /** Filterable, registered, and waiting on a slot. */
  awaitingSlot: string[];
  /** Registered and JSON-only. Steady state, not a degradation. */
  jsonOnly: string[];
  /** Not in the registry at all. Stored verbatim, readable back. */
  unknownKeys: string[];
}

export interface WriteResult {
  world: SimWorld;
  outcome: EntryWriteOutcome | null;
  error: string | null;
}

/**
 * The no-own-transaction core, shared by `writeEntry()` and the bulk path.
 *
 * Emits no events — the engine's `writeWithinTransaction()` does not either,
 * because the bulk caller batches its logging at chunk level.
 */
function writeWithin(
  world: SimWorld,
  modelId: number,
  fields: PayloadFields,
): { world: SimWorld; outcome: EntryWriteOutcome } | { error: string } {
  const map = loadLiveSlotMap(world, modelId);

  // ADR 0038 rejects a write to a deleting model, where ADR 0037 strips a
  // deleting field's key. The inversion is deliberate: a field deletion leaves
  // a valid residual entry, and a model deletion leaves nothing to preserve.
  if (map.modelDeleted) {
    return { error: `EntryWriter: model ${modelId} is being deleted; writes are refused.` };
  }

  // Canonicalise BEFORE the payload is stored, not merely before it is planned.
  const canonical = canonicalise(map, fields);

  const split = splitPayload(map, canonical);
  if (!split.ok) return { error: split.error };
  const { plan } = split;

  const now = simNow(world);
  const seq = { ...world.seq };
  const entryId = seq.entry++;

  const slots: SimEntry['slots'] = {};
  const slotsWritten: SlotWriteRef[] = [];
  for (const [pageId, columns] of Object.entries(plan.slotWrites)) {
    const id = Number(pageId);
    slots[id] = { ...columns };
    for (const slotColumn of Object.keys(columns)) {
      // The map is the registry, and it already knows who holds this column,
      // so the owner is looked up rather than threaded through the plan — the
      // plan stays the shape the engine's `SplitPlan` is.
      const owner = Object.values(map.byFieldName).find(
        e => e.pageId === id && e.slotColumn === slotColumn,
      );
      slotsWritten.push({ pageId: id, slotColumn, fieldName: owner?.fieldName ?? slotColumn });
    }
  }

  const entry: SimEntry = {
    id: entryId,
    tenantId: world.tenantId,
    modelId,
    // The canonicalised but otherwise RAW payload. Coercion above touched the
    // slot plan and nothing else.
    fields: canonical,
    slots,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  const enqueued = plan.missingSlotFields.length > 0;
  const syncQueue = enqueued
    ? [...world.syncQueue, { id: seq.sync++, entryId, createdAt: now } satisfies SimSyncRow]
    : world.syncQueue;

  return {
    world: { ...world, entries: [...world.entries, entry], syncQueue, seq },
    outcome: {
      entryId,
      enqueuedForBackfill: enqueued,
      slotsWritten,
      awaitingSlot: plan.missingSlotFields,
      jsonOnly: plan.jsonOnlyFields,
      unknownKeys: plan.unknownKeys,
    },
  };
}

/**
 * `$stardust->write(new EntryPayload(...))`.
 *
 * A rejected write returns the world untouched with `error` set — the engine
 * validates and coerces before it inserts anything, so a failure genuinely
 * leaves no partial state behind.
 */
export function writeEntry(
  world: SimWorld,
  modelId: number,
  fields: PayloadFields,
): WriteResult {
  const written = writeWithin(world, modelId, fields);
  if ('error' in written) {
    return { world, outcome: null, error: written.error };
  }

  const { outcome } = written;
  const next = emit(written.world, (nextSeq, tick) => {
    const lines = [
      line(
        nextSeq(),
        tick,
        'api',
        'entry_written',
        {
          tenant_id: world.tenantId,
          entry_id: outcome.entryId,
          model_id: modelId,
          slots_written: outcome.slotsWritten.length,
          enqueued: outcome.enqueuedForBackfill,
        },
      ),
    ];
    if (outcome.enqueuedForBackfill) {
      lines.push(
        line(
          nextSeq(),
          tick,
          'api',
          'exhaustion_fallback',
          {
            tenant_id: world.tenantId,
            entry_id: outcome.entryId,
            model_id: modelId,
          },
        ),
      );
    }
    return lines;
  });

  return { world: next, outcome, error: null };
}

/* ------------------------------------------------------------------ *
 * BulkIngestor
 * ------------------------------------------------------------------ */

/** `BulkIngestor::SYNC_THRESHOLD` — above this you must use `submitBulkWrite()`. */
export const SYNC_THRESHOLD = 1000;

/** `BulkIngestOptions::$chunkSize` default. One transaction per chunk. */
export const DEFAULT_CHUNK_SIZE = 500;

export interface BulkChunkOutcome {
  chunkIndex: number;
  chunkSize: number;
  outcome: 'committed' | 'rolled_back';
  entryIds: number[];
  failureReason: string | null;
}

export interface BulkResult {
  world: SimWorld;
  chunks: BulkChunkOutcome[];
  entriesCommitted: number;
  error: string | null;
}

/**
 * `$stardust->bulkWrite($payloads)`.
 *
 * One transaction per chunk, and a chunk that fails rolls back **alone** —
 * earlier chunks stay committed and later ones still run. That is why the
 * world is snapshotted per chunk rather than per entry.
 *
 * Per-entry `entry_written` events are deliberately not emitted here. The
 * engine logs the bulk path at chunk level only, so seeding 600 rows produces
 * two log lines rather than six hundred.
 */
export function bulkWriteEntries(
  world: SimWorld,
  modelId: number,
  payloads: PayloadFields[],
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): BulkResult {
  if (payloads.length > SYNC_THRESHOLD) {
    const next = emit(world, (nextSeq, tick) => [
      line(
        nextSeq(),
        tick,
        'bulk_api',
        'payload_too_large',
        {
          tenant_id: world.tenantId,
          entry_count: payloads.length,
          threshold: SYNC_THRESHOLD,
        },
        'warn',
      ),
    ]);
    return {
      world: next,
      chunks: [],
      entriesCommitted: 0,
      error:
        `Synchronous bulk ingest accepts at most ${SYNC_THRESHOLD} entities; ` +
        `got ${payloads.length}. Use submitBulkWrite() instead.`,
    };
  }

  if (payloads.length === 0) {
    return { world, chunks: [], entriesCommitted: 0, error: null };
  }

  let current = world;
  const chunks: BulkChunkOutcome[] = [];
  let entriesCommitted = 0;

  for (let index = 0; index * chunkSize < payloads.length; index++) {
    const slice = payloads.slice(index * chunkSize, (index + 1) * chunkSize);
    // The pre-chunk world. Restoring it is this simulation's rollback.
    const before = current;

    let failure: string | null = null;
    const entryIds: number[] = [];
    for (const payload of slice) {
      const written = writeWithin(current, modelId, payload);
      if ('error' in written) {
        failure = written.error;
        break;
      }
      current = written.world;
      entryIds.push(written.outcome.entryId);
    }

    if (failure !== null) {
      current = emit(before, (nextSeq, tick) => [
        line(
          nextSeq(),
          tick,
          'bulk_api',
          'bulk_chunk_rolled_back',
          {
            chunk_index: index,
            chunk_size: slice.length,
            failure_reason: failure,
          },
          'error',
        ),
      ]);
      chunks.push({
        chunkIndex: index,
        chunkSize: slice.length,
        outcome: 'rolled_back',
        entryIds: [],
        failureReason: failure,
      });
      continue;
    }

    entriesCommitted += slice.length;
    const first = entryIds[0];
    const last = entryIds[entryIds.length - 1];
    current = emit(current, (nextSeq, tick) => [
      line(
        nextSeq(),
        tick,
        'bulk_api',
        'bulk_chunk_committed',
        {
          chunk_index: index,
          chunk_size: slice.length,
          entry_id_first: first ?? null,
          entry_id_last: last ?? null,
        },
      ),
    ]);
    chunks.push({
      chunkIndex: index,
      chunkSize: slice.length,
      outcome: 'committed',
      entryIds,
      failureReason: null,
    });
  }

  return { world: current, chunks, entriesCommitted, error: null };
}

/* ------------------------------------------------------------------ *
 * EntryDeleter
 * ------------------------------------------------------------------ */

/**
 * `$stardust->deleteEntry($tenantId, $entryId)`.
 *
 * Stamps `deleted_at` and nothing else. Two properties worth not tidying away:
 *
 * - **Slot columns are retained.** Nothing can reach them without joining
 *   through a live `entry_data` row, so clearing them would be a write per
 *   occupied page for no observable difference. The engine pins this with a
 *   test so that a future change which starts nulling them is a decision
 *   rather than a drift.
 * - **It returns `false` rather than throwing** for a missing, already-deleted
 *   or foreign row, where `update()` would throw. Silently discarding an
 *   update loses data the caller believed it had written; a repeated delete
 *   has already achieved what the caller asked for.
 *
 * No event is emitted when nothing transitioned.
 */
export function deleteEntry(
  world: SimWorld,
  entryId: number,
): { world: SimWorld; deleted: boolean } {
  const entry = world.entries.find(
    e => e.id === entryId && e.tenantId === world.tenantId && e.deletedAt === null,
  );
  if (entry === undefined) return { world, deleted: false };

  const model = world.models.find(m => m.id === entry.modelId);
  // A missing model row is legal and must not read as "deleting" — the engine
  // uses a LEFT JOIN here for exactly that reason.
  if (model !== undefined && model.deletedAt !== null) return { world, deleted: false };

  const now = simNow(world);
  const entries = world.entries.map(e =>
    e.id === entryId ? { ...e, deletedAt: now, updatedAt: now } : e,
  );

  const next = emit({ ...world, entries }, (nextSeq, tick) => [
    line(
      nextSeq(),
      tick,
      'api',
      'entry_deleted',
      {
        tenant_id: world.tenantId,
        entry_id: entryId,
        model_id: entry.modelId,
      },
    ),
  ]);

  return { world: next, deleted: true };
}

/* ------------------------------------------------------------------ *
 * The world-aware half of the payload draft
 *
 * These two live here rather than in `payload.ts` because they need a world,
 * and `world.ts` imports `payload.ts` to build its initial state — the same
 * split that keeps `draft.ts` free of `registry.ts`.
 * ------------------------------------------------------------------ */

/**
 * The payload form's rows, derived from the registry every time.
 *
 * **Derived rather than stored, and that is the point.** An earlier version
 * snapshotted the model's fields into the draft, which meant a field added in
 * the schema builder after the form was opened simply did not appear here —
 * silently, with no way for a visitor to tell that the form and the model had
 * come apart. Reading the registry on every render makes the form current by
 * construction instead of by remembering to resynchronise it.
 *
 * Registry order is id order — `stardust_fields` has no sort column — so this
 * is the order the fields were committed in, not the order they were dragged
 * into. Section A already says so out loud; this is where it shows. Unknown
 * keys come after, in the order they were added.
 */
export function payloadRowsFor(world: SimWorld, draft: SimPayloadDraft): PayloadRow[] {
  if (draft.modelId === null) return [];

  const registered = fieldsOf(world, draft.modelId).map<PayloadRow>(f => ({
    key: `f${f.id}`,
    name: f.name,
    value: draft.values[f.name] ?? '',
    declaredType: f.declaredType,
    fieldId: f.id,
  }));

  const unknown = draft.unknownKeys.map<PayloadRow>(u => ({
    key: u.key,
    name: u.name,
    value: draft.values[u.name] ?? '',
    declaredType: null,
    fieldId: null,
  }));

  return [...registered, ...unknown];
}

/**
 * Turn the rows into an `EntryPayload::$fields` array.
 *
 * Two decisions, both of which change what a visitor sees in `entry_data`:
 *
 * 1. **An empty input omits the key entirely.** A client that sends nothing
 *    sends nothing, and the alternative — writing `null` for every blank box —
 *    would fill the stored JSON with keys nobody typed. (It matters more later
 *    than it does here: for `updateEntry()` an absent key and an explicit
 *    `null` are genuinely different operations.)
 * 2. **A numeric-looking value for an `int` or `numeric` field becomes a JSON
 *    number; anything else stays a string.** That is what a real client does,
 *    and it is how the stored payload comes to disagree with the slot column —
 *    the JSON keeps whatever the client sent, and only the slot is coerced.
 *    Typing `abc` into an `int` field is therefore a perfectly legal write that
 *    stores the string, and which would fail coercion later, once a slot exists
 *    to coerce for.
 */
export function toPayloadFields(rows: PayloadRow[]): PayloadFields {
  const out: PayloadFields = {};

  for (const row of rows) {
    if (row.value === '') continue;

    if (row.declaredType === 'int' || row.declaredType === 'numeric') {
      const asNumber = Number(row.value);
      out[row.name] =
        row.value.trim() !== '' && Number.isFinite(asNumber) ? asNumber : row.value;
      continue;
    }

    out[row.name] = row.value;
  }

  return out;
}

/**
 * The seed batch.
 *
 * **Deterministic, and that is a correctness requirement rather than a
 * preference.** `Math.random()` inside a reducer is `new Date()` wearing a
 * hat: StrictMode double-invokes reducers, so a random seed would build two
 * different worlds and the one React kept would not be the one the events
 * described. Every value here is a function of the row index.
 *
 * Every seventh row omits its last field, so *absence* is present in the data
 * from the start — a model where every row is fully populated would make the
 * backfill look more uniform than backfills are.
 */
export const SEED_COUNT = 600;

const SEED_WORDS = [
  'aurora', 'basalt', 'cinder', 'dunes', 'ember', 'fjord', 'gantry', 'harbor',
  'ingot', 'juniper', 'kelvin', 'lumen', 'mesa', 'nimbus', 'onyx', 'pylon',
];

export function seedPayloads(
  world: SimWorld,
  modelId: number,
  count: number = SEED_COUNT,
): PayloadFields[] {
  const fields = fieldsOf(world, modelId);
  const out: PayloadFields[] = [];

  for (let i = 0; i < count; i++) {
    const payload: PayloadFields = {};

    fields.forEach((field, index) => {
      const isLast = index === fields.length - 1;
      if (isLast && fields.length > 1 && i % 7 === 6) return;

      switch (field.declaredType) {
        case 'string':
          payload[field.name] = `${SEED_WORDS[i % SEED_WORDS.length]}-${i + 1}`;
          break;
        case 'int':
          payload[field.name] = ((i + 1) * 37) % 900 + 100;
          break;
        case 'numeric':
          payload[field.name] = Math.round((i + 1) * 1.5 * 100) / 100;
          break;
        case 'datetime':
          payload[field.name] = new Date(Date.UTC(2026, 0, 1) + i * 3_600_000)
            .toISOString()
            .slice(0, 19)
            .replace('T', ' ');
          break;
      }
    });

    out.push(payload);
  }

  return out;
}
