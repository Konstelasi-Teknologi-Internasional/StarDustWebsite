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
import type { DaemonActivityMap } from './daemons/types';
import { emptyDraft, type SimDraft } from './draft';
import type { SimEvent } from './events';
import { emptyPayloadDraft, type SimPayloadDraft } from './payload';
import { emptyQueryDraft, type QueryDraft } from './query';
import type {
  DeclaredType,
  SimCheckpoint,
  SimDlqRow,
  SimEntry,
  SimExportJob,
  SimField,
  SimImportJob,
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
 * **What does and does not require a bump**, because it is currently
 * discoverable only by reading one spread operator in `persist.ts`, and every
 * later stage faces the question:
 *
 * - A new **top-level** member of `SimWorld` does **not**. The restore is
 *   `{ ...emptyWorld(), ...parsed }`, so an older snapshot that lacks the key
 *   simply keeps the default. Bumping for one of those discards a returning
 *   visitor's schema in exchange for nothing.
 * - A new member of `clock`, `seq`, `draft`, `payloadDraft` or `queryDraft` no
 *   longer does either. Those used to be restored wholesale, so a new member
 *   came back `undefined`; `persist.ts` now merges each onto its
 *   `emptyWorld()` default, and a missing one comes back as that default
 *   instead. A new nested draft joins that list in `persist.ts` — `queryDraft`
 *   did, in the same change that added it.
 * - An incompatible change to an existing shape still **does**. A member whose
 *   meaning or type changed is not repaired by a merge, and that is the case
 *   this constant is now for.
 *
 * And do not add the new member to `persist.ts`'s `isWorldish()` either: that
 * probe is deliberately cheap, and requiring a key every older snapshot lacks
 * reintroduces the discard through the back door.
 *
 * 2 — `SimWorld` gained `draft`, so a v1 snapshot restores without one.
 * 3 — the job, checkpoint and DLQ shapes were aligned to the real tables:
 *     `jobs` split into `importJobs` / `exportJobs`, and `seq` gained members.
 *     `seq` is restored wholesale rather than merged, so a v2 snapshot would
 *     come back with `seq.importJob === undefined` — a persisted broken world,
 *     which is exactly what this constant exists to prevent.
 *     That is the reasoning the nested merge above now retires: from this
 *     version on, a missing member of one of those four comes back as its
 *     default instead of `undefined`, so it is no longer a bump's job to
 *     prevent it.
 *
 * `payloadDraft` arrived without a bump, as the first application of the rule
 * above: it is top-level, `seq` already carried `entry` and `sync`, and a v3
 * snapshot restores with an empty form and every model it had. It stayed at 3
 * through the merge, too. While section C was still iterating, `payloadDraft`
 * changed shape under a fixed version, and snapshots written mid-iteration
 * restored with `payloadDraft.values === undefined` — which threw during
 * render, unmounting the tree along with the Reset button that would have
 * cleared it. That is a shape-churn hazard no version constant can catch,
 * because the version does not move while a member is still being built; the
 * merge is what fixes it, and it repairs those snapshots in place rather than
 * discarding a returning visitor's schema.
 */
export const SIM_SCHEMA_VERSION = 3;

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
  checkpoint: number;
  /**
   * Two counters, not one. `stardust_import_jobs` and `stardust_export_jobs`
   * are separate tables with separate auto-increments, so import job 1 and
   * export job 1 coexist — which a single shared counter would quietly hide.
   */
  importJob: number;
  exportJob: number;
  dlq: number;
  event: number;
}

/**
 * What the last lifecycle call reported.
 *
 * Grown rather than reshaped, and deliberately: `fieldId` widened from `number`
 * to `number | null` and `action` gained two members, both of which every
 * persisted value still satisfies. Replacing the pair with a tagged `target`
 * would have read better and would have forced a `SIM_SCHEMA_VERSION` bump —
 * discarding a returning visitor's schema to buy a nicer union.
 */
export interface LifecycleOutcome {
  /** Null for a model-scoped call, which names no field. */
  fieldId: number | null;
  /** Set by the model-scoped calls; absent for the field ones. */
  modelId?: number;
  action:
    | 'promote'
    | 'demote'
    | 'retype'
    | 'rename-field'
    | 'rename-model'
    | 'delete-field'
    | 'delete-model';
  /** Null on success. The engine's exception message otherwise. */
  error: string | null;
  /**
   * The deletions only, and it is not the same thing as `error === null`.
   *
   * They return `false` rather than throwing when there is nothing to do — an
   * unknown id, another tenant's, or a deletion already in flight, three cases
   * deliberately made indistinguishable. Without this the panel could not tell
   * "severed" from "that did nothing", and the second is the one worth saying
   * out loud, because a typo in an id is otherwise silent.
   */
  noop?: boolean;
}

export interface SimWorld {
  /** Snapshot compatibility, not `stardust_schema_version`. */
  simVersion: number;

  /** Every visitor is one tenant. Multi-tenancy is shown, not driven. */
  tenantId: number;

  /** `stardust_schema_version.version` — bumped by registry changes. */
  schemaVersion: number;
  /**
   * `stardust_schema_version.updated_at`. The singleton is a real row with
   * three columns, and the inspector renders it as one, so the timestamp is
   * held rather than implied.
   */
  schemaVersionUpdatedAt: string;

  models: SimModel[];
  fields: SimField[];
  pages: SimPage[];
  slots: SimSlot[];
  entries: SimEntry[];
  syncQueue: SimSyncRow[];
  checkpoints: SimCheckpoint[];
  importJobs: SimImportJob[];
  exportJobs: SimExportJob[];
  dlq: SimDlqRow[];

  clock: SimClock;
  /** Capped in the reducer; a log that grows forever is a memory leak. */
  events: SimEvent[];
  seq: SimSequences;

  /**
   * What each daemon did on its last poll. **Not a table** — see
   * {@link ./daemons/types.ts}. The event log is capped, so a daemon that last
   * ran two hundred lines ago would otherwise have nothing to show on its card.
   */
  daemonActivity: DaemonActivityMap;

  /**
   * The outcome of the last promote/demote call. Not a table either.
   *
   * The engine throws on a refused lifecycle and returns `void` on an accepted
   * one, so there is nothing to render without holding it — and the refusals
   * are worth rendering, because "a field already has a retype in flight" is a
   * rule rather than a mistake.
   */
  lastLifecycle: LifecycleOutcome | null;

  /**
   * The model being defined but not yet committed. One of the two members
   * here with no table behind it — see {@link ./draft.ts} for why it lives on
   * the world anyway.
   */
  draft: SimDraft;

  /**
   * The entry being composed but not yet written. The other one; the same
   * argument applies, and {@link ./payload.ts} carries it.
   */
  payloadDraft: SimPayloadDraft;

  /**
   * The filter being built, the sort, the cursor walked so far, and what the
   * last run produced. The third of these, and {@link ./query.ts} carries the
   * argument — which is the same argument, for the third time, and is why the
   * rule is written on `SIM_SCHEMA_VERSION` rather than restated here.
   */
  queryDraft: QueryDraft;
}

/** How many log lines the world retains. The panel scrolls; memory doesn't. */
export const EVENT_LOG_LIMIT = 200;

export function emptyWorld(): SimWorld {
  return {
    simVersion: SIM_SCHEMA_VERSION,
    tenantId: 1,
    schemaVersion: 0,
    // Bootstrap seeds the singleton row; it is never absent, only unbumped.
    schemaVersionUpdatedAt: formatSimTime(0),
    models: [],
    fields: [],
    pages: [],
    slots: [],
    entries: [],
    syncQueue: [],
    checkpoints: [],
    importJobs: [],
    exportJobs: [],
    dlq: [],
    clock: initialClock(),
    events: [],
    daemonActivity: {},
    lastLifecycle: null,
    seq: {
      model: 1,
      field: 1,
      page: 1,
      slot: 1,
      entry: 1,
      sync: 1,
      checkpoint: 1,
      importJob: 1,
      exportJob: 1,
      dlq: 1,
      event: 1,
    },
    draft: emptyDraft(),
    payloadDraft: emptyPayloadDraft(),
    queryDraft: emptyQueryDraft(),
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
  return formatSimTime(world.clock.tick);
}

/** `Y-m-d H:i:s` in UTC, `tick` seconds after the world's epoch. */
function formatSimTime(tick: number): string {
  const ms = Date.UTC(2026, 0, 1) + tick * 1000;
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

/**
 * The slot columns of a page that are spoken for — anything but `free`.
 *
 * Deliberately wider than {@link LIVE_SLOT_STATUSES}. A `tombstoned` slot is
 * not live and can never answer a filter again, but its column still holds the
 * old values until the sweep nullifies them chunk by chunk. Hiding it would
 * make a page look tidier than it is during exactly the window where the
 * residue is the thing worth seeing.
 *
 * It lives here rather than in the component that renders the columns, because
 * "which slots count as in use" is a rule about slot statuses, and those are
 * only allowed to be decided in one place.
 */
export function slotColumnsInUse(world: SimWorld, pageId: number): Set<string> {
  return new Set(
    world.slots
      .filter(s => s.pageId === pageId && s.status !== 'free')
      .map(s => s.slotColumn),
  );
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
