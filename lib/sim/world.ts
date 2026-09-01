/**
 * The world, and the state it starts in.
 *
 * `emptyWorld()` is the state immediately after the engine's `bootstrap()`
 * returns: every registry and data-plane table exists and every one of them is
 * empty. In particular there are **no pages**, because bootstrap provisions
 * none — a page appears only when something asks for capacity. That absence is
 * the lesson the table inspector is built around, so it must not be seeded
 * away for the sake of a livelier first screen.
 */

import { initialClock, type SimClock } from './clock';
import { emptyDraft, type SimDraft } from './draft';
import type { SimEvent } from './events';
import type {
  DeclaredType,
  SimCheckpoint,
  SimDlqRow,
  SimEntry,
  SimField,
  SimJob,
  SimModel,
  SimPage,
  SimSlot,
  SimSyncRow,
  SlotFamily,
} from './types';

/**
 * Bumping this invalidates every snapshot in every returning visitor's
 * browser. Do it whenever a shape below changes incompatibly — a stale
 * snapshot that still parses is worse than one that is discarded.
 *
 * 2 — `SimWorld` gained `draft`, so a v1 snapshot restores without one.
 */
export const SIM_SCHEMA_VERSION = 2;

/**
 * A page carries exactly 60 typed slots, split 25/15/10/10.
 *
 * These are `PageProvisioner::STRING_SLOTS` and friends in the engine, which
 * is the source of truth. The 60 is also claimed on the site's landing page,
 * so if it ever changes it changes in both places in the same commit.
 */
export const SLOTS_PER_PAGE = 60;

export const FAMILY_SLOT_COUNTS: Record<SlotFamily, number> = {
  str: 25,
  int: 15,
  num: 10,
  dt: 10,
};

/** A field's declared type decides which family of slots it can ever occupy. */
export const FAMILY_OF: Record<DeclaredType, SlotFamily> = {
  string: 'str',
  int: 'int',
  numeric: 'num',
  datetime: 'dt',
};

/** `i_str_01`, `i_int_07`, … — the engine's slot-column naming, exactly. */
export function slotColumnName(family: SlotFamily, index: number): string {
  return `i_${family}_${String(index).padStart(2, '0')}`;
}

/**
 * Auto-increment counters, held explicitly.
 *
 * The engine's ids are BIGINT auto-increments and the inspector renders them,
 * so they cannot be array indices — a deleted row must not hand its id to the
 * next insert.
 */
export interface SimSequences {
  model: number;
  field: number;
  page: number;
  slot: number;
  entry: number;
  sync: number;
  job: number;
  dlq: number;
  event: number;
}

export interface SimWorld {
  /** Snapshot compatibility, not `stardust_schema_version`. */
  simVersion: number;

  /** Every visitor is one tenant. Multi-tenancy is shown, not driven. */
  tenantId: number;

  /** `stardust_schema_version.version` — bumped by registry changes. */
  schemaVersion: number;

  models: SimModel[];
  fields: SimField[];
  pages: SimPage[];
  slots: SimSlot[];
  entries: SimEntry[];
  syncQueue: SimSyncRow[];
  checkpoints: SimCheckpoint[];
  jobs: SimJob[];
  dlq: SimDlqRow[];

  clock: SimClock;
  /** Capped in the reducer; a log that grows forever is a memory leak. */
  events: SimEvent[];
  seq: SimSequences;

  /**
   * The model being defined but not yet committed. The one member here with
   * no table behind it — see {@link ./draft.ts} for why it lives on the world
   * anyway.
   */
  draft: SimDraft;
}

/** How many log lines the world retains. The panel scrolls; memory doesn't. */
export const EVENT_LOG_LIMIT = 200;

export function emptyWorld(): SimWorld {
  return {
    simVersion: SIM_SCHEMA_VERSION,
    tenantId: 1,
    schemaVersion: 0,
    models: [],
    fields: [],
    pages: [],
    slots: [],
    entries: [],
    syncQueue: [],
    checkpoints: [],
    jobs: [],
    dlq: [],
    clock: initialClock(),
    events: [],
    seq: { model: 1, field: 1, page: 1, slot: 1, entry: 1, sync: 1, job: 1, dlq: 1, event: 1 },
    draft: emptyDraft(),
  };
}

/**
 * `DATETIME` values, derived from the tick rather than from the wall clock.
 *
 * The engine writes `Y-m-d H:i:s` in UTC and this produces the same shape, so
 * the inspector shows a plausible column. It is a function of the world
 * because the reducers that call it must stay pure — `new Date()` inside a
 * reducer gives two different answers under StrictMode's double-invoke, which
 * is exactly the class of bug the reducers are written to avoid.
 *
 * Rows created without the clock running therefore share a timestamp, which
 * is what a real database does for rows inserted in the same second.
 */
export function simNow(world: SimWorld): string {
  const ms = Date.UTC(2026, 0, 1) + world.clock.tick * 1000;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Live slot statuses — the three a write path materialises into. A field with
 * a slot in any of these holds it, which is what the "at most one live slot
 * per field" invariant is about.
 */
export const LIVE_SLOT_STATUSES = ['assigned', 'backfilling', 'ready'] as const;

/**
 * Queryable slot statuses — deliberately narrower than the live set.
 *
 * `backfilling` is live but not queryable: a filter against it is rejected at
 * pre-flight rather than answered from a half-built index. That gap between
 * "the registry says filterable" and "a filter works right now" is the whole
 * promotion window.
 */
export const QUERYABLE_SLOT_STATUSES = ['assigned', 'ready'] as const;

export function fieldsOf(world: SimWorld, modelId: number): SimField[] {
  return world.fields.filter(f => f.modelId === modelId && f.deletedAt === null);
}

export function liveSlotForField(world: SimWorld, fieldId: number): SimSlot | undefined {
  return world.slots.find(
    s =>
      s.fieldId === fieldId &&
      (LIVE_SLOT_STATUSES as readonly string[]).includes(s.status),
  );
}

/**
 * Whether a filter on this field would work *right now*.
 *
 * The one answer to the question sections A, B, D and E all ask, so that they
 * cannot drift apart. It is derived from the slot table rather than from
 * `SimField.isFilterable`, and the gap between the two is the point:
 *
 * - `'none'`     — no live slot. The registry may well say `is_filterable = 1`;
 *                  that is intent, and a filter is rejected at pre-flight.
 * - `'building'` — a slot exists and is `backfilling`. Still rejected, because
 *                  a half-built index must never answer as though it were
 *                  complete. This is the whole promotion window.
 * - `'live'`     — `assigned` or `ready`. A filter reads a real index.
 *
 * Only `'none'` is reachable until a daemon runs, which is why the "not
 * indexed yet" marker in the model builder is derived here rather than
 * hardcoded — the builder then needs no change at all once the daemons land.
 */
export type FieldIndexState = 'none' | 'building' | 'live';

export function fieldIndexState(world: SimWorld, fieldId: number): FieldIndexState {
  const slot = liveSlotForField(world, fieldId);
  if (slot === undefined) return 'none';
  return (QUERYABLE_SLOT_STATUSES as readonly string[]).includes(slot.status)
    ? 'live'
    : 'building';
}
