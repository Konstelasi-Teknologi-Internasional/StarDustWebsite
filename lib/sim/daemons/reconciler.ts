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
 * insert**. What this file mirrors is that *list*, of which it implements two —
 * so what matters here is the **index**, not the end. `sync_queue` is source 1
 * and `retype_backfill` is source 3. The import-job drain is source 2 and
 * belongs to the operations section; when it lands it goes *between* these two,
 * not after them. Sources 4, 5 and 6 (rename, field purge, model purge) belong
 * to the schema-change section and do append.
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

import { correlationId, emit } from '../emit';
import { detail, line, type SimEvent } from '../events';
import {
  applySlotWrites,
  backfillEntry,
  identityCoerce,
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
const WORK_SOURCES: WorkSourceName[] = ['sync_queue', 'retype_backfill'];

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
      const claim =
        source === 'sync_queue'
          ? tickSyncQueue(state, worker, corrId)
          : tickRetypeBackfill(state, worker, corrId);

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
            ? 'nothing to claim'
            : `${busy.length} of ${RECONCILER_WORKERS} workers claimed work`,
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
      detail({
        correlation_id: corrId,
        worker,
        queue: 'sync_queue',
        rows_claimed: rows.length,
      }),
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
            detail({
              correlation_id: corrId,
              entry_id: row.entryId,
              reason: row.reason,
              message: row.errorMessage,
            }),
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
        detail({
          correlation_id: corrId,
          worker,
          queue: 'sync_queue',
          rows_processed: processed,
          rows_dlq: dlq.length,
        }),
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
      detail({
        correlation_id: corrId,
        worker: claim.worker,
        queue: 'sync_queue',
        rows_claimed: claim.claimed,
        awaiting: [...names].join(',') || 'none',
      }),
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
          detail({
            correlation_id: corrId,
            worker,
            queue: 'retype_backfill',
            field_id: fieldId,
          }),
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

  state.world = emit(state.world, (nextSeq, tick): SimEvent[] => [
    line(
      nextSeq(),
      tick,
      'reconciler',
      'chunk_claimed',
      detail({
        correlation_id: corrId,
        worker,
        queue: 'retype_backfill',
        field_id: fieldId,
        tenant_id: state.world.tenantId,
        cursor: checkpoint.lastProcessedId,
      }),
    ),
  ]);

  const nullEvents: { entryId: number; reason: CoercionNullReason }[] = [];
  const touched = new Map<number, SimEntry>();

  for (const entry of chunk) {
    const coercion = identityCoerce(entry.fields, field.name, field.declaredType);

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
          detail({
            correlation_id: corrId,
            field_id: fieldId,
            entry_id: event.entryId,
            source_type: field.declaredType,
            target_type: field.declaredType,
            reason: event.reason,
          }),
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
        detail({
          correlation_id: corrId,
          worker,
          queue: 'retype_backfill',
          field_id: fieldId,
          rows_processed: chunk.length,
          coercion_nulls: nullEvents.length,
          final_chunk: isFinalChunk,
        }),
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
          detail({
            correlation_id: corrId,
            tenant_id: state.world.tenantId,
            field_id: fieldId,
            slot_assignment_id: liveSlot.id,
            declared_type: field.declaredType,
            is_filterable: true,
          }),
        ),
      );
    }

    return lines;
  });

  return { ...claim, claimed: chunk.length, firstId: chunk[0]?.id ?? null, lastId: cursor };
}
