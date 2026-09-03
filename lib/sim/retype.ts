/**
 * `RetypeInitiator`, simulated — the promotion and demotion shapes only.
 *
 * The engine's initiator runs one entry point for three jobs: change a field's
 * declared type, promote it to filterable, or demote it. The playground builds
 * the two filterability shapes here because they are what the daemon section is
 * *about*; changing a declared type is a data migration through a coercion
 * matrix, and it belongs with rename and delete in the schema-change section.
 *
 * That split is honest rather than convenient: a promotion changes no types, so
 * the backfill copies values through the matrix's **identity diagonal** — a
 * pure copy. Building the rest of the matrix here would be building the section
 * after this one.
 *
 * ## Two shapes, and the difference is whether anything backfills
 *
 * **Promotion (filterable target)** is one atomic tuple: flip the registry
 * flag, tombstone any live slot, reserve a new `backfilling` slot — or defer —
 * bump the schema version, open a checkpoint. The Reconciler finishes it.
 *
 * **Demotion (non-filterable target)** is registry-only: flip the flag,
 * tombstone the live slot, bump, stop. There is no reservation and no
 * checkpoint, because under ADR 0034 a non-filterable field holds no slot and
 * the JSON payload is authoritative for it. Reads fall straight back to
 * extracting from the document. This is also the only thing in the playground
 * that produces a tombstone, which is what gives the Liberator work.
 */

import {
  checkpointFor,
  jobNameFor,
  lifecycleConflict,
  runningCheckpointFor,
  upsertCheckpoint,
  JOB_PREFIXES,
} from './checkpoints';
import { emit } from './emit';
import { line, type SimEvent } from './events';
import { reserveForBackfill, tombstoneLiveSlot } from './reserve';
import { isCategoricallyRejected } from './backfill';
import type { DeclaredType, SimCheckpoint } from './types';
import { simNow, type SimWorld } from './world';

/**
 * The thirteen-character namespace prefix. All four are the same length, which
 * is what lets every claim query share one substring offset — see
 * {@link ./checkpoints.ts}, which now owns all four and the exclusivity rule
 * they enforce between them.
 */
export const RETYPE_JOB_PREFIX = JOB_PREFIXES.retype;

export function retypeJobName(fieldId: number): string {
  return jobNameFor('retype', fieldId);
}

export function checkpointForField(
  world: SimWorld,
  fieldId: number,
): SimCheckpoint | undefined {
  return checkpointFor(world, 'retype', fieldId);
}

export function runningCheckpointForField(
  world: SimWorld,
  fieldId: number,
): SimCheckpoint | undefined {
  return runningCheckpointFor(world, 'retype', fieldId);
}

/** A backfill in flight: the checkpoint, and the partition it is draining. */
export interface PromotionProgress {
  fieldId: number;
  fieldName: string;
  checkpoint: SimCheckpoint;
  /** `last_processed_id` — an entry id, not a row count. */
  cursor: number;
  /** Rows in the partition. Derived here; no table stores it. */
  total: number;
}

/**
 * Every backfill currently running, with the denominator its progress is
 * measured against.
 *
 * `backfill_checkpoints` stores a cursor and a status and nothing else, so a
 * total is something whoever owns the partition derives — `CheckpointBar`'s
 * docblock is explicit that computing one inside the component "would mean
 * inventing a column". This is that derivation, done once. Two surfaces need
 * it now (the section D readout and the clock bar's running summary) and two
 * copies of it would be free to disagree about which rows count.
 *
 * Note `cursor` is an entry **id**, not a row count, so it is only a
 * denominator-compatible numerator while ids are dense — which they are here,
 * because nothing in the playground deletes an entry mid-backfill. The same
 * caveat the Liberator's sweep bar carries.
 */
export function runningPromotions(world: SimWorld): PromotionProgress[] {
  const out: PromotionProgress[] = [];

  for (const checkpoint of world.checkpoints) {
    if (checkpoint.status !== 'running') continue;
    if (!checkpoint.jobName.startsWith(RETYPE_JOB_PREFIX)) continue;

    const fieldId = Number(checkpoint.jobName.slice(RETYPE_JOB_PREFIX.length));
    const field = world.fields.find(f => f.id === fieldId);
    if (field === undefined) continue;

    out.push({
      fieldId,
      fieldName: field.name,
      checkpoint,
      cursor: checkpoint.lastProcessedId,
      total: world.entries.filter(
        e => e.modelId === field.modelId && e.tenantId === world.tenantId,
      ).length,
    });
  }

  return out;
}

export interface InitiateResult {
  world: SimWorld;
  error: string | null;
}

/**
 * `$stardust->promoteFieldToFilterable($tenantId, $fieldId)`.
 *
 * Returns as soon as the registry commits. Whether anything remains to be done
 * depends entirely on capacity, and both outcomes are normal:
 *
 *   - **Capacity exists** — the slot is reserved inside this very tuple, the
 *     field goes straight to `backfilling`, and the Watcher never wakes. This
 *     is the common path in a running deployment.
 *   - **No indexed free slot of the family** — the reservation is *deferred*.
 *     The checkpoint opens anyway, the field becomes pending demand, the
 *     Watcher provisions on its next poll, and the Reconciler retries the
 *     reservation. This is the cold-start path, and it is the one worth
 *     watching.
 */
export function promoteField(
  world: SimWorld,
  fieldId: number,
  correlationId: string,
): InitiateResult {
  return initiate(world, fieldId, { isFilterable: true }, correlationId);
}

/** `$stardust->demoteFieldFromFilterable($tenantId, $fieldId)`. */
export function demoteField(
  world: SimWorld,
  fieldId: number,
  correlationId: string,
): InitiateResult {
  return initiate(world, fieldId, { isFilterable: false }, correlationId);
}

/**
 * `$stardust->retypeField($tenantId, $fieldId, $newDeclaredType)`.
 *
 * The third shape of the same tuple, and the only one that migrates *data*: the
 * declared type is overwritten immediately, the old one is stashed on the
 * checkpoint, and the Reconciler rewrites every slot value in the model through
 * the ADR 0024 matrix cell those two names pick out.
 *
 * **Filterability is deliberately not a parameter here.** A retype carries the
 * field's current `is_filterable` forward, exactly as the engine does when
 * `$newIsFilterable` is null — combining the two in one call would make the
 * tuple's four shapes eight, and the two questions are asked at different times
 * by different people.
 */
export function retypeField(
  world: SimWorld,
  fieldId: number,
  newDeclaredType: DeclaredType,
  correlationId: string,
): InitiateResult {
  return initiate(world, fieldId, { declaredType: newDeclaredType }, correlationId);
}

/** What the caller is changing. Anything omitted is carried forward unchanged. */
interface RetypeTarget {
  declaredType?: DeclaredType;
  isFilterable?: boolean;
}

function initiate(
  world: SimWorld,
  fieldId: number,
  target: RetypeTarget,
  correlationId: string,
): InitiateResult {
  const field = world.fields.find(f => f.id === fieldId);
  if (field === undefined) {
    return { world, error: `RetypeInitiator: field ${fieldId} does not exist.` };
  }

  const targetDeclaredType = target.declaredType ?? field.declaredType;
  const targetIsFilterable = target.isFilterable ?? field.isFilterable;

  // The engine refuses an overlapping lifecycle rather than queueing it. A
  // second promotion while the first is still draining would reset a live
  // cursor, and the checkpoint's unique job name is the real backstop.
  if (runningCheckpointForField(world, fieldId) !== undefined) {
    return {
      world,
      error: `RetypeInProgressException: field ${fieldId} already has a retype in flight.`,
    };
  }

  // The other two legs, in the engine's fixed rename → retype → delete order.
  // The rename leg matters for a reason a filterability change makes easy to
  // miss: the backfill executor locates values by field *name*, so mid-rename
  // every un-migrated row reads as "value absent" and its slot is written NULL,
  // silently, with no `coercion_null` because no coercion was attempted.
  //
  // This check used to be folded into the existence test above as
  // `field.deletedAt !== null`, which reported a deleting field as one that
  // does not exist. It is a different fact and now says so.
  const conflict = lifecycleConflict(world, field, 'retype');
  if (conflict !== null) return { world, error: conflict };

  // **The categorical refusal, ahead of every mutation.** ADR 0024 declines
  // `int↔datetime` and `numeric↔datetime` rather than choosing between seconds
  // since the epoch, milliseconds, a packed `YYYYMMDD` and a Julian day — all
  // defensible, all different, and a wrong guess would be silent.
  if (isCategoricallyRejected(field.declaredType, targetDeclaredType)) {
    return {
      world,
      error:
        `IncompatibleRetypeException: ${field.declaredType} → ${targetDeclaredType} is ` +
        'categorically rejected; there is no defensible epoch convention to pick.',
    };
  }

  if (
    field.declaredType === targetDeclaredType &&
    field.isFilterable === targetIsFilterable
  ) {
    return {
      world,
      error: `RetypeInitiator: field '${field.name}' is already is_filterable = ${targetIsFilterable ? 1 : 0}.`,
    };
  }

  const now = simNow(world);
  const oldIsFilterable = field.isFilterable;

  // Step 1 — the registry flag. Everything below reads it, including the
  // reservation's own ADR 0034 guard, so it has to move first.
  let next: SimWorld = {
    ...world,
    fields: world.fields.map(f =>
      f.id === fieldId
        ? {
            ...f,
            declaredType: targetDeclaredType,
            isFilterable: targetIsFilterable,
            updatedAt: now,
          }
        : f,
    ),
  };

  // Step 2 — tombstone the current live slot, if there is one. A promotion
  // normally has none under ADR 0034, and that is not exceptional.
  const tombstoned = tombstoneLiveSlot(next, fieldId);
  next = tombstoned.world;
  const oldSlotId = tombstoned.slot?.id ?? null;

  if (!targetIsFilterable) {
    // Registry-only. Bump and stop: no reservation, no checkpoint, nothing for
    // the Reconciler to claim. `backfill_required: false` is what tells an
    // operator that a missing later `promote_to_ready` is not a stall.
    next = {
      ...next,
      schemaVersion: next.schemaVersion + 1,
      schemaVersionUpdatedAt: now,
    };
    return {
      world: emitRetypeStarted(next, {
        correlationId,
        fieldId,
        oldDeclaredType: field.declaredType,
        newDeclaredType: targetDeclaredType,
        oldIsFilterable,
        newIsFilterable: targetIsFilterable,
        oldSlotId,
        newSlotId: null,
        backfillRequired: false,
      }),
      error: null,
    };
  }

  // Step 3 — reserve the replacement, or defer. There is deliberately no eager
  // DDL here: the initiator does not provision a page to make room for itself.
  const reserved = reserveForBackfill(next, fieldId, correlationId);
  next = reserved.world;

  // Step 4 — the version bump. The reserver bumps on its own success path, so
  // this compensating bump covers the deferred branch. **Exactly one bump on
  // every branch** is the invariant; check it if a third shape ever lands here.
  if (reserved.assignment === null) {
    next = {
      ...next,
      schemaVersion: next.schemaVersion + 1,
      schemaVersionUpdatedAt: now,
    };
  }

  // Step 5 — the checkpoint, as an **upsert**. A field is not a one-way door:
  // nothing removes a completed retype checkpoint, so a plain insert would make
  // promote → demote → promote fail on the third call with a duplicate key,
  // and the running-check above offers no protection because it reports false
  // for a terminal row.
  //
  // `sourceDeclaredType` is passed rather than defaulted. A promotion changes
  // no type, so it is the field's own — the ADR 0024 identity diagonal. Letting
  // it default to null here would drain a *second* lifecycle through the wrong
  // matrix cell with no event and no exception.
  next = upsertCheckpoint(next, 'retype', fieldId, now, field.declaredType);

  return {
    world: emitRetypeStarted(next, {
      correlationId,
      fieldId,
      oldDeclaredType: field.declaredType,
      newDeclaredType: targetDeclaredType,
      oldIsFilterable,
      newIsFilterable: targetIsFilterable,
      oldSlotId,
      newSlotId: reserved.assignment?.slotAssignmentId ?? null,
      backfillRequired: true,
    }),
    error: null,
  };
}

function emitRetypeStarted(
  world: SimWorld,
  fields: {
    correlationId: string;
    fieldId: number;
    oldDeclaredType: DeclaredType;
    newDeclaredType: DeclaredType;
    oldIsFilterable: boolean;
    newIsFilterable: boolean;
    oldSlotId: number | null;
    newSlotId: number | null;
    backfillRequired: boolean;
  },
): SimWorld {
  return emit(world, (nextSeq, tick): SimEvent[] => [
    line(
      nextSeq(),
      tick,
      'registry',
      'retype_started',
      {
        correlation_id: fields.correlationId,
        tenant_id: world.tenantId,
        field_id: fields.fieldId,
        old_declared_type: fields.oldDeclaredType,
        new_declared_type: fields.newDeclaredType,
        old_is_filterable: fields.oldIsFilterable,
        new_is_filterable: fields.newIsFilterable,
        old_slot_assignment_id: fields.oldSlotId,
        new_slot_assignment_id: fields.newSlotId,
        backfill_required: fields.backfillRequired,
        // Guarded on `backfill_required`. A registry-only transition always
        // leaves the new slot null but is *complete*, not deferred, and
        // reporting it as deferred would show permanent phantom backlog.
        deferred_assignment: fields.backfillRequired && fields.newSlotId === null,
      },
    ),
  ]);
}
