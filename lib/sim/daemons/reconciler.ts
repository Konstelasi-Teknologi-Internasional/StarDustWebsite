/**
 * The Reconciler — multi-worker drain.
 *
 * There is no PID guard and no leader election. `SELECT … FOR UPDATE SKIP
 * LOCKED` is the *only* coordination primitive, and horizontal scale is
 * literally "run more processes". Three of them run here, and the thing worth
 * watching is that they claim disjoint work without ever knowing about each
 * other: worker two does not wait for worker one, it steps over the rows worker
 * one is holding and takes the next ones.
 *
 * ## Work sources are ordered by the engine's list, not by ours
 *
 * The engine round-robins six sources in a fixed order, and that order is
 * observable in an event stream, so its rule is **new sources append, never
 * insert**. What this file mirrors is that *list*, of which it implements five —
 * so what matters here is the **index**, not the end. `sync_queue` is source 1,
 * then `retype_backfill` 3, `rename_backfill` 4, `delete_purge` 5 and
 * `model_delete_purge` 6. The import-job drain is source **2** and belongs to
 * the operations section; when it lands it goes *between* the first two, not
 * on the end.
 *
 * **The model purge is last on purpose**, and not merely by arrival order: it
 * and the sync-queue drain both touch `stardust_sync_queue`, and the engine
 * puts the destructive one behind the one that keeps writes available.
 *
 * ## Two failure states, and only one of them is here
 *
 * `CAPACITY_WAIT` — a source needs a slot that does not exist — short-circuits
 * the rest of the worker's tick, because the contention is on shared state and
 * marching on would spend the other sources' budgets against the same wall.
 *
 * `LOCK_WAIT` is the engine's other one, and it is deliberately absent: see
 * {@link ./types.ts}. Nothing in a browser contends for a row.
 */

import { advanceCheckpoint, JOB_PREFIXES } from '../checkpoints';
import { correlationId, emit } from '../emit';
import { line, type SimEvent } from '../events';
import {
  applySlotWrites,
  backfillEntry,
  coerceForRetype,
  type CoercionNullReason,
} from '../backfill';
import { reserveForBackfill, reserveForExhaustion } from '../reserve';
import { RETYPE_JOB_PREFIX } from '../retype';
import type { SimCheckpoint, SimDlqRow, SimEntry } from '../types';
import { fieldsOf, liveSlotForField, simNow, type SimWorld } from '../world';
import type { TickOutcome, WorkerClaim, WorkSourceName } from './types';

/** `Config::$reconcilerChunkSize`. One transaction per chunk. */
export const RECONCILER_CHUNK_SIZE = 500;

/** How many worker processes the playground runs. `bin/stardust reconciler` ×3. */
export const RECONCILER_WORKERS = 3;

/** The engine's round-robin order, restricted to the sources that exist here. */
const WORK_SOURCES: WorkSourceName[] = [
  'sync_queue',
  'retype_backfill',
  'rename_backfill',
  'delete_purge',
  'model_delete_purge',
];

/**
 * One tick of one source, for one worker. `null` means "found nothing to
 * claim", which is different from claiming a chunk and doing nothing with it.
 */
type SourceTick = (state: TickState, worker: string, corrId: string) => WorkerClaim | null;

/**
 * The dispatch, as a total map over {@link WorkSourceName}.
 *
 * A `Record` rather than a chain of ternaries, so adding a source to the union
 * without implementing it is a typecheck failure rather than a silent fall
 * through to whichever branch happened to be last. That is not hypothetical —
 * the chain this replaced had the fallthrough case doing the newest source's
 * work, and a sixth would have inherited it.
 */
const SOURCE_TICKS: Record<WorkSourceName, SourceTick> = {
  sync_queue: (state, worker, corrId) => tickSyncQueue(state, worker, corrId),
  retype_backfill: (state, worker, corrId) => tickRetypeBackfill(state, worker, corrId),
  rename_backfill: (state, worker, corrId) => tickRenameBackfill(state, worker, corrId),
  delete_purge: (state, worker, corrId) => tickDeletePurge(state, worker, corrId),
  model_delete_purge: (state, worker, corrId) => tickModelPurge(state, worker, corrId),
};

/** Mutable bookkeeping for one tick, shared across the three workers. */
interface TickState {
  world: SimWorld;
  /** Queue ids some worker is already holding — the `SKIP LOCKED` effect. */
  heldQueueIds: Set<number>;
  /** Checkpoint job names some worker is already holding. Same reason. */
  heldJobNames: Set<string>;
  claims: WorkerClaim[];
}

export function reconcilerTick(world: SimWorld): SimWorld {
  const state: TickState = {
    world,
    heldQueueIds: new Set(),
    heldJobNames: new Set(),
    claims: [],
  };

  for (let i = 0; i < RECONCILER_WORKERS; i++) {
    const worker = `w${i + 1}`;
    let didSomething = false;

    for (const source of WORK_SOURCES) {
      const corrId = correlationId('reconciler', world.clock.tick, state.claims.length);
      const claim = SOURCE_TICKS[source](state, worker, corrId);

      if (claim === null) continue;

      state.claims.push(claim);
      didSomething = true;

      // A capacity wait short-circuits this worker's tick. The next source
      // would be reaching for the same missing capacity.
      if (claim.outcome === 'capacity_wait') break;
    }

    if (!didSomething) {
      state.claims.push({
        worker,
        source: null,
        outcome: 'idle',
        claimed: 0,
        firstId: null,
        lastId: null,
      });
    }
  }

  const busy = state.claims.filter(c => c.outcome !== 'idle');

  return {
    ...state.world,
    daemonActivity: {
      ...state.world.daemonActivity,
      reconciler: {
        tick: world.clock.tick,
        action:
          busy.length === 0
            ? { key: 'daemonRoom.activity.reconcilerIdle' }
            : {
                key: 'daemonRoom.activity.reconcilerBusy',
                params: { busy: busy.length, total: RECONCILER_WORKERS },
              },
        workers: state.claims,
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * Source 1 — SyncQueueWorkSource
 * ------------------------------------------------------------------ */

/**
 * Claim a chunk of `stardust_sync_queue`, backfill every entry in it, and
 * delete the rows — or roll the whole thing back.
 *
 * **The rollback is whole-chunk, never per-row.** If a single entry in the
 * chunk still has a filterable field with no live slot, nothing in the chunk
 * commits: no slot value, no queue deletion, and not even the dead-letter rows
 * the failing entries produced. The queue rows stay claimable and the next tick
 * re-runs identical work. Skipping the unmapped row and committing the rest
 * would advance past work that has not been done.
 *
 * After the rollback the still-unmapped field names go to the exhaustion
 * reserver, which is what makes the whole thing self-draining: without it a
 * field registered filterable through the schema builder would sit in the
 * Watcher's demand gauge forever and nothing would ever satisfy it.
 */
function tickSyncQueue(
  state: TickState,
  worker: string,
  corrId: string,
): WorkerClaim | null {
  const { world } = state;

  const rows = world.syncQueue
    .filter(r => !state.heldQueueIds.has(r.id))
    .sort((a, b) => a.id - b.id)
    .slice(0, RECONCILER_CHUNK_SIZE);

  if (rows.length === 0) return null;

  for (const row of rows) state.heldQueueIds.add(row.id);

  const claim: WorkerClaim = {
    worker,
    source: 'sync_queue',
    outcome: 'work_done',
    claimed: rows.length,
    firstId: rows[0].entryId,
    lastId: rows[rows.length - 1].entryId,
  };

  // Emitted from *inside* the chunk transaction, so it survives a rollback.
  // It is a claim-*attempt* event; moving it after the commit would make it
  // fire alongside `chunk_complete` and say nothing.
  state.world = emit(world, (nextSeq, tick): SimEvent[] => [
    line(
      nextSeq(),
      tick,
      'reconciler',
      'chunk_claimed',
      {
        correlation_id: corrId,
        worker,
        queue: 'sync_queue',
        rows_claimed: rows.length,
      },
    ),
  ]);

  const entriesById = new Map(state.world.entries.map(e => [e.id, e] as const));
  const touched = new Map<number, SimEntry>();
  const dlqDrafts: { entryId: number; modelId: number; reason: SimDlqRow['reason']; error: string }[] = [];
  const stillUnmapped = new Map<number, string[]>();

  for (const row of rows) {
    const outcome = backfillEntry(state.world, row.entryId);

    if (!outcome.ok) {
      const entry = entriesById.get(row.entryId);
      dlqDrafts.push({
        entryId: row.entryId,
        modelId: entry?.modelId ?? 0,
        reason: outcome.reason,
        error: outcome.error,
      });
      continue;
    }

    if (outcome.result.stillUnmapped.length > 0) {
      stillUnmapped.set(row.entryId, outcome.result.stillUnmapped);
      continue;
    }

    const entry = entriesById.get(row.entryId);
    if (entry !== undefined) {
      touched.set(entry.id, applySlotWrites(touched.get(entry.id) ?? entry, outcome.result.slotWrites));
    }
  }

  if (stillUnmapped.size > 0) {
    return rollBackAndReserve(state, claim, corrId, stillUnmapped);
  }

  // Commit: the mirrored values, the dead letters, and the queue deletions.
  const claimedIds = new Set(rows.map(r => r.id));
  const now = simNow(state.world);
  const seq = { ...state.world.seq };

  const dlq: SimDlqRow[] = dlqDrafts.map(draft => ({
    id: seq.dlq++,
    source: 'sync_queue',
    entryId: draft.entryId,
    tenantId: state.world.tenantId,
    modelId: draft.modelId,
    reason: draft.reason,
    errorMessage: draft.error,
    failedAt: now,
    retryCount: 0,
    chunkCorrelationId: corrId,
  }));

  state.world = {
    ...state.world,
    entries: state.world.entries.map(e => touched.get(e.id) ?? e),
    syncQueue: state.world.syncQueue.filter(r => !claimedIds.has(r.id)),
    dlq: [...state.world.dlq, ...dlq],
    seq,
  };

  const processed = rows.length - dlq.length;

  state.world = emit(state.world, (nextSeq, tick): SimEvent[] => {
    const lines: SimEvent[] = [];
    if (dlq.length > 0) {
      for (const row of dlq) {
        lines.push(
          line(
            nextSeq(),
            tick,
            'reconciler',
            'dlq_inserted',
            {
              correlation_id: corrId,
              entry_id: row.entryId,
              reason: row.reason,
              message: row.errorMessage,
            },
            'warn',
          ),
        );
      }
    }
    lines.push(
      line(
        nextSeq(),
        tick,
        'reconciler',
        // `chunk_partial` when any row was quarantined, `chunk_complete` when
        // every survivor succeeded. Two names, because "some of it worked" is
        // a different operational fact from "all of it did".
        dlq.length > 0 ? 'chunk_partial' : 'chunk_complete',
        {
          correlation_id: corrId,
          worker,
          queue: 'sync_queue',
          rows_processed: processed,
          rows_dlq: dlq.length,
        },
      ),
    );
    return lines;
  });

  return claim;
}

/**
 * `UnmappedFieldReserver` — the ADR 0007 exhaustion reservation.
 *
 * Three things here are load-bearing and none of them is obvious:
 *
 *   1. **The reservation happens after the rollback, never inside the chunk.**
 *      Reserving bumps the schema-version singleton, and holding that row for a
 *      chunk's duration would make every worker contend on it.
 *   2. **At least one reserved means no `capacity_wait`.** The reserver's own
 *      `slot_reserved` line is the record; firing a capacity alarm on a
 *      successful recovery would make every recovery look like an incident.
 *   3. **A failed reservation is swallowed.** Two workers can reach the same
 *      field from disjoint chunks, and the loser trips the one-live-slot-per-
 *      field invariant. That is the desired end state reached by somebody else.
 */
function rollBackAndReserve(
  state: TickState,
  claim: WorkerClaim,
  corrId: string,
  stillUnmapped: Map<number, string[]>,
): WorkerClaim {
  // The rollback itself is the absence of any write above — `state.world` still
  // carries only the `chunk_claimed` line, which is exactly what surviving a
  // rollback means.
  const names = new Set<string>();
  const modelIds = new Set<number>();
  for (const [entryId, fieldNames] of stillUnmapped) {
    const entry = state.world.entries.find(e => e.id === entryId);
    if (entry === undefined) continue;
    modelIds.add(entry.modelId);
    for (const name of fieldNames) names.add(name);
  }

  let reserved = 0;
  for (const modelId of modelIds) {
    for (const field of fieldsOf(state.world, modelId)) {
      if (!names.has(field.name)) continue;
      if (liveSlotForField(state.world, field.id) !== undefined) continue;

      const result = reserveForExhaustion(state.world, field.id, corrId);
      state.world = result.world;
      if (result.assignment !== null) reserved++;
    }
  }

  if (reserved > 0) {
    // The next tick re-claims the same rows and drains them against the
    // committed slot. Reported as work done, because a reservation is work —
    // but annotated, because the chunk itself rolled back and nothing drained.
    return { ...claim, outcome: 'work_done', note: 'reserved_and_rolled_back' };
  }

  state.world = emit(state.world, (nextSeq, tick): SimEvent[] => [
    line(
      nextSeq(),
      tick,
      'reconciler',
      'capacity_wait',
      {
        correlation_id: corrId,
        worker: claim.worker,
        queue: 'sync_queue',
        rows_claimed: claim.claimed,
        awaiting: [...names].join(',') || 'none',
      },
      'warn',
    ),
  ]);

  return { ...claim, outcome: 'capacity_wait' };
}

/* ------------------------------------------------------------------ *
 * Source 3 — RetypeBackfillWorkSource
 * ------------------------------------------------------------------ */

/**
 * Drain one promotion checkpoint by one chunk.
 *
 * The cursor lives on the checkpoint row and only advances on commit, so a
 * chunk that does not complete is retried identically — nothing skipped,
 * nothing lost. On the final chunk the slot flips `backfilling → ready`, the
 * checkpoint is marked completed, and the schema version bumps, all together:
 * a reader that refreshed between those would see a queryable slot the version
 * had not yet invalidated its cache for.
 */
function tickRetypeBackfill(
  state: TickState,
  worker: string,
  corrId: string,
): WorkerClaim | null {
  const checkpoint = state.world.checkpoints.find(
    c =>
      c.status === 'running' &&
      c.jobName.startsWith(RETYPE_JOB_PREFIX) &&
      !state.heldJobNames.has(c.jobName),
  );
  if (checkpoint === undefined) return null;

  state.heldJobNames.add(checkpoint.jobName);

  const fieldId = Number(checkpoint.jobName.slice(RETYPE_JOB_PREFIX.length));
  const field = state.world.fields.find(f => f.id === fieldId);
  if (field === undefined) return null;

  const claim: WorkerClaim = {
    worker,
    source: 'retype_backfill',
    outcome: 'work_done',
    claimed: 0,
    firstId: null,
    lastId: null,
  };

  // The deferred reservation. The initiator found no indexed free slot of this
  // family and opened the checkpoint anyway; this is where it retries, once per
  // tick, until the Watcher has provisioned one.
  let slot = liveSlotForField(state.world, fieldId);
  if (slot === undefined) {
    const result = reserveForBackfill(state.world, fieldId, corrId);
    state.world = result.world;

    if (result.assignment === null) {
      state.world = emit(state.world, (nextSeq, tick): SimEvent[] => [
        line(
          nextSeq(),
          tick,
          'reconciler',
          'capacity_wait',
          {
            correlation_id: corrId,
            worker,
            queue: 'retype_backfill',
            field_id: fieldId,
          },
          'warn',
        ),
      ]);
      return { ...claim, outcome: 'capacity_wait' };
    }

    slot = liveSlotForField(state.world, fieldId);
  }

  // Hoisted to a `const` so the closures below keep the narrowed type. `slot`
  // is a `let` because the deferred reservation above may have replaced it.
  if (slot === undefined) return null;
  const liveSlot = slot;

  const partition = state.world.entries
    .filter(
      e =>
        e.tenantId === state.world.tenantId &&
        e.modelId === field.modelId &&
        e.id > checkpoint.lastProcessedId,
    )
    .sort((a, b) => a.id - b.id);

  const chunk = partition.slice(0, RECONCILER_CHUNK_SIZE);
  const isFinalChunk = chunk.length < RECONCILER_CHUNK_SIZE;

  // The matrix cell. `declared_type` was **overwritten by the initiator** in the
  // same transaction that opened this checkpoint, so the source type cannot be
  // recovered from the field row — it lives on the checkpoint, which is the
  // entire reason `backfill_checkpoints.source_declared_type` exists.
  //
  // The fallback is the diagonal: a promotion changes no type and writes the
  // field's own type into the column, so a null here can only be a checkpoint
  // written before that column did, and reading it as "no change" is right.
  const targetType = field.declaredType;
  const sourceType = checkpoint.sourceDeclaredType ?? targetType;

  state.world = emit(state.world, (nextSeq, tick): SimEvent[] => [
    line(
      nextSeq(),
      tick,
      'reconciler',
      'chunk_claimed',
      {
        correlation_id: corrId,
        worker,
        queue: 'retype_backfill',
        field_id: fieldId,
        tenant_id: state.world.tenantId,
        cursor: checkpoint.lastProcessedId,
      },
    ),
  ]);

  const nullEvents: { entryId: number; reason: CoercionNullReason }[] = [];
  const touched = new Map<number, SimEntry>();

  for (const entry of chunk) {
    const coercion = coerceForRetype(entry.fields, field.name, sourceType, targetType);

    // **The upsert is unconditional, and that is not an accident.** The engine
    // computes `$coercedValue = $outcome->isCoerced() ? $outcome->value() :
    // null` and writes it outside any branch, so an entry whose JSON never had
    // this key still gets a page row with the column NULL. Skipping the write
    // for a `not_attempted` value is the obvious shortcut and it is wrong twice
    // over: the backfill would leave the partition unevenly materialised, and
    // the page table would then be missing rows the Liberator's sweep counts.
    //
    // What `not_attempted` actually suppresses is the *event*, not the write —
    // nothing was attempted, so there is nothing to report.
    const value = coercion.kind === 'coerced' ? coercion.value : null;
    if (coercion.kind === 'null_coerced') {
      nullEvents.push({ entryId: entry.id, reason: coercion.reason });
    }

    touched.set(
      entry.id,
      applySlotWrites(entry, { [liveSlot.pageId]: { [liveSlot.slotColumn]: value } }),
    );
  }

  const cursor = chunk.length > 0 ? chunk[chunk.length - 1].id : checkpoint.lastProcessedId;
  const now = simNow(state.world);

  const nextCheckpoint: SimCheckpoint = {
    ...checkpoint,
    lastProcessedId: cursor,
    status: isFinalChunk ? 'completed' : 'running',
    updatedAt: now,
    completedAt: isFinalChunk ? now : null,
  };

  state.world = {
    ...state.world,
    entries: state.world.entries.map(e => touched.get(e.id) ?? e),
    checkpoints: state.world.checkpoints.map(c =>
      c.jobName === checkpoint.jobName ? nextCheckpoint : c,
    ),
    slots: isFinalChunk
      ? state.world.slots.map(s =>
          s.id === liveSlot.id ? { ...s, status: 'ready' as const, updatedAt: now } : s,
        )
      : state.world.slots,
    schemaVersion: isFinalChunk ? state.world.schemaVersion + 1 : state.world.schemaVersion,
    schemaVersionUpdatedAt: isFinalChunk ? now : state.world.schemaVersionUpdatedAt,
  };

  state.world = emit(state.world, (nextSeq, tick): SimEvent[] => {
    const lines: SimEvent[] = [];

    for (const event of nullEvents) {
      lines.push(
        line(
          nextSeq(),
          tick,
          'reconciler',
          'coercion_null',
          {
            correlation_id: corrId,
            field_id: fieldId,
            entry_id: event.entryId,
            source_type: sourceType,
            target_type: targetType,
            reason: event.reason,
          },
          'warn',
        ),
      );
    }

    lines.push(
      line(
        nextSeq(),
        tick,
        'reconciler',
        'chunk_complete',
        {
          correlation_id: corrId,
          worker,
          queue: 'retype_backfill',
          field_id: fieldId,
          rows_processed: chunk.length,
          coercion_nulls: nullEvents.length,
          final_chunk: isFinalChunk,
        },
      ),
    );

    if (isFinalChunk) {
      lines.push(
        line(
          nextSeq(),
          tick,
          // `registry`, not `reconciler`. The Reconciler did the work; the
          // promotion is a registry state change.
          'registry',
          'promote_to_ready',
          {
            correlation_id: corrId,
            tenant_id: state.world.tenantId,
            field_id: fieldId,
            slot_assignment_id: liveSlot.id,
            declared_type: field.declaredType,
            is_filterable: true,
          },
        ),
      );
    }

    return lines;
  });

  return { ...claim, claimed: chunk.length, firstId: chunk[0]?.id ?? null, lastId: cursor };
}

/* ------------------------------------------------------------------ *
 * Source 4 — RenameBackfillWorkSource
 * ------------------------------------------------------------------ */

/**
 * Move one bounded chunk of `entry_data.fields` from a field's pre-rename key
 * to its current one.
 *
 * **No slot is touched, so this source has no `capacity_wait`.** A rename can
 * never be blocked on inventory; the only outcomes are work done and idle. That
 * is the one structural difference from source 3, and it is why the deferred
 * reservation that opens `tickRetypeBackfill()` has no counterpart here.
 *
 * ## The rewrite is one statement, not decode-mutate-encode
 *
 * The engine issues `JSON_REMOVE(JSON_SET(…))` per chunk rather than decoding
 * each payload in PHP, because `json_decode($json, true)` is not round-trip
 * faithful: a payload whose keys form a complete sequential list from zero
 * re-encodes as a JSON **array**, so `{"0":"x","1":"y"}` silently becomes
 * `["x","y"]`. Field names are `VARCHAR(128)` with no numeric restriction, so
 * `"0"` is a legal name and that payload is reachable. JavaScript objects have
 * no such collapse, so the hazard does not port — but the **two path guards**
 * that statement carries do, and they are behaviour rather than encoding.
 */
function tickRenameBackfill(
  state: TickState,
  worker: string,
  corrId: string,
): WorkerClaim | null {
  const checkpoint = state.world.checkpoints.find(
    c =>
      c.status === 'running' &&
      c.jobName.startsWith(JOB_PREFIXES.rename) &&
      !state.heldJobNames.has(c.jobName),
  );
  if (checkpoint === undefined) return null;

  const fieldId = Number(checkpoint.jobName.slice(JOB_PREFIXES.rename.length));
  const field = state.world.fields.find(f => f.id === fieldId);

  // The claim's integrity predicate: `f.previous_name IS NOT NULL`. Not
  // idempotence — a checkpoint whose bridge marker was cleared has no old key
  // to migrate from, so claiming it would scan the whole partition and rewrite
  // nothing, forever. It is also what an operator-named job could never satisfy.
  // Deliberately *before* `heldJobNames`, so an unclaimable row does not block
  // the next worker from reaching a claimable one.
  if (field === undefined || field.previousName === null) return null;

  state.heldJobNames.add(checkpoint.jobName);

  const previousName = field.previousName;
  const currentName = field.name;

  // **No `deleted_at` predicate**, matching the engine's `fetchChunkIds()` and
  // the retype drain. A soft-deleted row can be read by nothing, but leaving it
  // on the stale key would desynchronise its payload from the registry
  // permanently — and `deleted_at` is not a hard delete.
  const partition = state.world.entries
    .filter(
      e =>
        e.tenantId === state.world.tenantId &&
        e.modelId === field.modelId &&
        e.id > checkpoint.lastProcessedId,
    )
    .sort((a, b) => a.id - b.id);

  const chunk = partition.slice(0, RECONCILER_CHUNK_SIZE);
  const isFinalChunk = chunk.length < RECONCILER_CHUNK_SIZE;

  state.world = emit(state.world, (nextSeq, tick): SimEvent[] => [
    line(nextSeq(), tick, 'reconciler', 'chunk_claimed', {
      correlation_id: corrId,
      worker,
      queue: 'rename_backfill',
      field_id: fieldId,
      tenant_id: state.world.tenantId,
      cursor: checkpoint.lastProcessedId,
    }),
  ]);

  const touched = new Map<number, SimEntry>();
  for (const entry of chunk) {
    // Guard one — the old key is present. Idempotence, and it is what stops a
    // spurious `newKey: null` being written into rows that never carried the
    // field at all.
    if (!(previousName in entry.fields)) continue;
    // Guard two — the new key is not. A post-rename write wins over the stale
    // key: `canonicalise()` should already prevent both coexisting, but if they
    // ever do, the current name is the truth and the backfill must not clobber
    // it with an older value.
    if (currentName in entry.fields) continue;

    const fields = { ...entry.fields, [currentName]: entry.fields[previousName] };
    delete fields[previousName];
    touched.set(entry.id, { ...entry, fields });
  }

  const cursor = chunk.length > 0 ? chunk[chunk.length - 1].id : checkpoint.lastProcessedId;
  const now = simNow(state.world);

  state.world = {
    ...state.world,
    entries: state.world.entries.map(e => touched.get(e.id) ?? e),
    // The final chunk clears the bridge marker, marks the checkpoint completed
    // and bumps the version **together**. A reader that refreshed its snapshot
    // between the clear and the bump would lose the fallback while un-migrated
    // rows still existed.
    fields: isFinalChunk
      ? state.world.fields.map(f =>
          f.id === fieldId ? { ...f, previousName: null, updatedAt: now } : f,
        )
      : state.world.fields,
    schemaVersion: isFinalChunk ? state.world.schemaVersion + 1 : state.world.schemaVersion,
    schemaVersionUpdatedAt: isFinalChunk ? now : state.world.schemaVersionUpdatedAt,
  };

  state.world = advanceCheckpoint(state.world, checkpoint.jobName, cursor, isFinalChunk);

  state.world = emit(state.world, (nextSeq, tick): SimEvent[] => {
    const lines: SimEvent[] = [
      line(nextSeq(), tick, 'reconciler', 'chunk_complete', {
        correlation_id: corrId,
        worker,
        queue: 'rename_backfill',
        field_id: fieldId,
        tenant_id: state.world.tenantId,
        rows_scanned: chunk.length,
        rows_rewritten: touched.size,
        final_chunk: isFinalChunk,
      }),
    ];

    if (isFinalChunk) {
      lines.push(
        // `registry`, not `reconciler`. The Reconciler did the work; the rename
        // landing is a registry state change — the same split `promote_to_ready`
        // makes on the source above.
        line(nextSeq(), tick, 'registry', 'rename_complete', {
          correlation_id: corrId,
          tenant_id: state.world.tenantId,
          model_id: field.modelId,
          field_id: fieldId,
          old_name: previousName,
          new_name: currentName,
        }),
      );
    }

    return lines;
  });

  return {
    worker,
    source: 'rename_backfill',
    outcome: 'work_done',
    claimed: chunk.length,
    firstId: chunk[0]?.id ?? null,
    lastId: chunk.length > 0 ? cursor : null,
  };
}

/* ------------------------------------------------------------------ *
 * Source 5 — DeletePurgeWorkSource
 * ------------------------------------------------------------------ */

/**
 * Strip one bounded chunk of a deleted field's key out of `entry_data.fields`.
 *
 * Structurally the rename drain with one key removed instead of two moved, and
 * **one path guard instead of two**: `JSON_CONTAINS_PATH` is for idempotence
 * and an honest `rowCount()` — `JSON_REMOVE` on an absent path is already a
 * no-op. The rename executor's second guard protects a destination key from a
 * stale write; a delete has no destination.
 *
 * The final chunk is where the whole lifecycle lands: the field row, its
 * checkpoint row and the version bump commit **together**. Dropping the field
 * row while the checkpoint survived would strand a `running` row whose join can
 * no longer resolve — precisely the orphan this feature exists to remove.
 */
function tickDeletePurge(
  state: TickState,
  worker: string,
  corrId: string,
): WorkerClaim | null {
  const checkpoint = state.world.checkpoints.find(
    c =>
      c.status === 'running' &&
      c.jobName.startsWith(JOB_PREFIXES.deleteField) &&
      !state.heldJobNames.has(c.jobName),
  );
  if (checkpoint === undefined) return null;

  const fieldId = Number(checkpoint.jobName.slice(JOB_PREFIXES.deleteField.length));
  const field = state.world.fields.find(f => f.id === fieldId);

  // The claim's integrity predicate: `f.deleted_at IS NOT NULL`. A checkpoint
  // whose marker was cleared has nothing to purge, and no operator-named job
  // could satisfy it.
  if (field === undefined || field.deletedAt === null) return null;

  state.heldJobNames.add(checkpoint.jobName);

  const fieldName = field.name;

  // No `deleted_at` predicate on the partition, matching every other drain: a
  // soft-deleted row can be read by nothing, but leaving its payload carrying a
  // key whose field no longer exists would desynchronise it from the registry
  // permanently.
  const partition = state.world.entries
    .filter(
      e =>
        e.tenantId === state.world.tenantId &&
        e.modelId === field.modelId &&
        e.id > checkpoint.lastProcessedId,
    )
    .sort((a, b) => a.id - b.id);

  const chunk = partition.slice(0, RECONCILER_CHUNK_SIZE);
  const isFinalChunk = chunk.length < RECONCILER_CHUNK_SIZE;

  state.world = emit(state.world, (nextSeq, tick): SimEvent[] => [
    line(nextSeq(), tick, 'reconciler', 'chunk_claimed', {
      correlation_id: corrId,
      worker,
      queue: 'delete_purge',
      field_id: fieldId,
      tenant_id: state.world.tenantId,
      cursor: checkpoint.lastProcessedId,
    }),
  ]);

  const touched = new Map<number, SimEntry>();
  for (const entry of chunk) {
    if (!(fieldName in entry.fields)) continue;
    const fields = { ...entry.fields };
    delete fields[fieldName];
    touched.set(entry.id, { ...entry, fields });
  }

  const cursor = chunk.length > 0 ? chunk[chunk.length - 1].id : checkpoint.lastProcessedId;
  const now = simNow(state.world);

  state.world = {
    ...state.world,
    entries: state.world.entries.map(e => touched.get(e.id) ?? e),
    // The hard delete the whole lifecycle has been working towards. It succeeds
    // because the initiator's two-step tombstone already released the RESTRICT
    // foreign key — the slot row survives as sweepable inventory with
    // `field_id` null, and the Liberator reclaims it without ever joining
    // `stardust_fields`.
    fields: isFinalChunk
      ? state.world.fields.filter(f => f.id !== fieldId)
      : state.world.fields,
    schemaVersion: isFinalChunk ? state.world.schemaVersion + 1 : state.world.schemaVersion,
    schemaVersionUpdatedAt: isFinalChunk ? now : state.world.schemaVersionUpdatedAt,
  };

  state.world = isFinalChunk
    ? // `delete()`, not `markCompleted()`. Every other lifecycle leaves an audit
      // row keyed to a field that still exists; here the field is gone, so a
      // surviving row is exactly the orphan being eliminated.
      { ...state.world, checkpoints: state.world.checkpoints.filter(c => c.jobName !== checkpoint.jobName) }
    : advanceCheckpoint(state.world, checkpoint.jobName, cursor, false);

  state.world = emit(state.world, (nextSeq, tick): SimEvent[] => {
    const lines: SimEvent[] = [
      line(nextSeq(), tick, 'reconciler', 'chunk_complete', {
        correlation_id: corrId,
        worker,
        queue: 'delete_purge',
        field_id: fieldId,
        tenant_id: state.world.tenantId,
        rows_scanned: chunk.length,
        rows_purged: touched.size,
        final_chunk: isFinalChunk,
      }),
    ];

    if (isFinalChunk) {
      lines.push(
        line(nextSeq(), tick, 'registry', 'delete_complete', {
          correlation_id: corrId,
          tenant_id: state.world.tenantId,
          model_id: field.modelId,
          field_id: fieldId,
          field_name: fieldName,
        }),
      );
    }

    return lines;
  });

  return {
    worker,
    source: 'delete_purge',
    outcome: 'work_done',
    claimed: chunk.length,
    firstId: chunk[0]?.id ?? null,
    lastId: chunk.length > 0 ? cursor : null,
  };
}

/* ------------------------------------------------------------------ *
 * Source 6 — ModelPurgeWorkSource
 * ------------------------------------------------------------------ */

/**
 * Delete one bounded chunk of a severed model's entries — **rows, not keys**.
 *
 * The only drain in the engine that destroys data, and three things about it
 * diverge from its five siblings:
 *
 *   1. **`stardust_sync_queue` rows die in the same chunk transaction.**
 *      Otherwise the sync-queue drain finds no `entry_data` row for each
 *      survivor and files a `missing_entry_data` dead letter — the purge
 *      manufacturing DLQ noise in proportion to pending writes.
 *   2. **The final chunk probes rather than assumes.** `chunk.length <
 *      chunkSize` is a hypothesis; a write transaction that opened before
 *      severance committed carries a pre-severance snapshot for its whole life
 *      and can commit rows afterwards. `entry_data.id` is auto-increment, so
 *      those land ahead of the cursor and are normally caught — unless they
 *      commit after what we thought was the last chunk. One probe turns a
 *      silent permanent orphan into an extra tick.
 *   3. **It re-asserts severance rather than trusting it**, with no status
 *      predicate on the slot sweep: a `tombstoned` row that still holds a
 *      `field_id` re-breaks the cascade, because the foreign key cares about
 *      the column and not the status. If ADR 0037's final chunk is wrong one
 *      row survives; if this one is wrong it fails *after* every earlier chunk
 *      has already committed its deletes, and there is **no DLQ path by
 *      design** — quarantining would leave the exact orphan this eliminates.
 */
function tickModelPurge(
  state: TickState,
  worker: string,
  corrId: string,
): WorkerClaim | null {
  const checkpoint = state.world.checkpoints.find(
    c =>
      c.status === 'running' &&
      c.jobName.startsWith(JOB_PREFIXES.deleteModel) &&
      !state.heldJobNames.has(c.jobName),
  );
  if (checkpoint === undefined) return null;

  const modelId = Number(checkpoint.jobName.slice(JOB_PREFIXES.deleteModel.length));
  const model = state.world.models.find(m => m.id === modelId);

  // The integrity predicate, and here it guards an unrecoverable DELETE rather
  // than a spurious key removal — which is why the engine carries it *and*
  // escapes its LIKE pattern.
  if (model === undefined || model.deletedAt === null) return null;

  state.heldJobNames.add(checkpoint.jobName);

  const partition = state.world.entries
    .filter(
      e =>
        e.tenantId === state.world.tenantId &&
        e.modelId === modelId &&
        e.id > checkpoint.lastProcessedId,
    )
    .sort((a, b) => a.id - b.id);

  const chunk = partition.slice(0, RECONCILER_CHUNK_SIZE);

  state.world = emit(state.world, (nextSeq, tick): SimEvent[] => [
    line(nextSeq(), tick, 'reconciler', 'chunk_claimed', {
      correlation_id: corrId,
      worker,
      queue: 'model_delete_purge',
      model_id: modelId,
      tenant_id: state.world.tenantId,
      cursor: checkpoint.lastProcessedId,
    }),
  ]);

  const doomed = new Set(chunk.map(e => e.id));
  const syncRowsDeleted = state.world.syncQueue.filter(r => doomed.has(r.entryId)).length;
  const cursor = chunk.length > 0 ? chunk[chunk.length - 1].id : checkpoint.lastProcessedId;
  const now = simNow(state.world);

  state.world = {
    ...state.world,
    // The extension-page rows go with them. In the engine that is a CASCADE off
    // `entry_data`; here the page values live on the entry, so it is the same
    // delete.
    entries: state.world.entries.filter(e => !doomed.has(e.id)),
    syncQueue: state.world.syncQueue.filter(r => !doomed.has(r.entryId)),
  };

  // The E0 probe. Cheap, and the difference between an extra tick and a
  // permanent orphan.
  const remaining = state.world.entries.some(
    e => e.tenantId === state.world.tenantId && e.modelId === modelId && e.id > cursor,
  );
  const finalising = chunk.length < RECONCILER_CHUNK_SIZE && !remaining;

  let fieldsDropped = 0;
  if (finalising) {
    // Re-assert severance. No status predicate, deliberately.
    state.world = {
      ...state.world,
      slots: state.world.slots.map(s =>
        s.fieldId !== null &&
        state.world.fields.some(f => f.id === s.fieldId && f.modelId === modelId)
          ? { ...s, fieldId: null, updatedAt: now }
          : s,
      ),
    };

    fieldsDropped = state.world.fields.filter(f => f.modelId === modelId).length;

    state.world = {
      ...state.world,
      // `fk_fields_model` is ON DELETE CASCADE, so dropping the model row takes
      // every field row with it. Spelled out rather than implied, because the
      // cascade is the reason nothing here deletes fields one at a time.
      models: state.world.models.filter(m => m.id !== modelId),
      fields: state.world.fields.filter(f => f.modelId !== modelId),
      checkpoints: state.world.checkpoints.filter(c => c.jobName !== checkpoint.jobName),
      schemaVersion: state.world.schemaVersion + 1,
      schemaVersionUpdatedAt: now,
    };
  } else {
    state.world = advanceCheckpoint(state.world, checkpoint.jobName, cursor, false);
  }

  state.world = emit(state.world, (nextSeq, tick): SimEvent[] => {
    const lines: SimEvent[] = [
      line(nextSeq(), tick, 'reconciler', 'chunk_complete', {
        correlation_id: corrId,
        worker,
        queue: 'model_delete_purge',
        model_id: modelId,
        tenant_id: state.world.tenantId,
        rows_scanned: chunk.length,
        rows_deleted: chunk.length,
        sync_rows_deleted: syncRowsDeleted,
        final_chunk: finalising,
        fields_dropped: fieldsDropped,
      }),
    ];

    if (finalising) {
      lines.push(
        line(nextSeq(), tick, 'registry', 'model_delete_complete', {
          correlation_id: corrId,
          tenant_id: state.world.tenantId,
          model_id: modelId,
          fields_dropped: fieldsDropped,
        }),
      );
    }

    return lines;
  });

  return {
    worker,
    source: 'model_delete_purge',
    outcome: 'work_done',
    claimed: chunk.length,
    firstId: chunk[0]?.id ?? null,
    lastId: chunk.length > 0 ? cursor : null,
  };
}
