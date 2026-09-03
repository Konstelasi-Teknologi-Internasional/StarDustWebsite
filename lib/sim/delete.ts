/**
 * `DeleteFieldInitiator` and `DeleteModelInitiator`, simulated — ADR 0037 and
 * ADR 0038.
 *
 * ## The one-line summary
 *
 * **Severance is synchronous and total; the purge is asynchronous; the registry
 * row dies last.** The call commits one transaction and returns, and from that
 * commit the field — or the whole model — is invisible to every first-class
 * surface. The Reconciler then removes the residue in chunks, and the *final
 * chunk* is what hard-deletes the registry row.
 *
 * ## `deleted_at` is a drain-window marker, not a soft-delete tier
 *
 * Exactly the `previous_name` pattern, on the same table for the same reason.
 * A non-null value means precisely "a deletion is in flight". **There is no
 * undelete**, nothing retains the row, and the purge's last chunk removes it.
 * If you find yourself adding a restore, that is a different feature.
 *
 * The DELETE is deferred, and not for the reason you would guess. The foreign
 * key does not force it: {@link tombstoneLiveSlot} nulls `field_id` before
 * flipping the status, which releases `fk_slot_assignments_field` inside the
 * same transaction — a fully synchronous `deleteField()` is mechanically
 * possible. It is deferred because **the purge needs the field's name, model
 * and tenant to build its JSON path**, and `backfill_checkpoints` has no column
 * for any of them.
 *
 * ## `is_filterable = 0` in the same update is load-bearing
 *
 * A field with `is_filterable = 1` and no live slot **is demand**. Left set, the
 * Watcher would provision a whole page for a field being deleted, and the ADR
 * 0007 exhaustion reserver would hand it a fresh slot — re-taking the foreign
 * key, so the purge's final delete fails permanently, because nothing retries
 * it. Both gate on the flag, so clearing it closes both.
 *
 * ## The four divergences of the model half
 *
 * 1. **Writes are refused, not stripped.** ADR 0037's most-easily-inverted
 *    rule, inverted. A deleted *field*'s key is stripped because a rejected
 *    write loses data while a strip converges; for a model there is no residual
 *    valid entry — the row would land behind the purge cursor (making the
 *    acceptance a lie) or ahead of it (a permanent orphan). Reads go **dark**,
 *    indistinguishable from a model that never existed.
 * 2. **The final chunk re-asserts severance rather than trusting it**, and the
 *    re-assertion carries no status predicate: a `tombstoned` slot that still
 *    holds a `field_id` re-breaks the cascade, because the FK cares about the
 *    column and not the status.
 * 3. **It destroys rows rather than keys** — and `stardust_sync_queue` rows die
 *    in the same chunk transaction, or the sync drain would find no entry for
 *    each survivor and file `missing_entry_data` dead letters in proportion to
 *    pending writes.
 * 4. **`stardust_models.deleted_at` is not redundant** with the field markers.
 *    A guard derived only from those has to be spelled "no field of this model
 *    is live", which is **true of every brand-new empty model** — and a model
 *    registered with no fields is legal.
 */

import {
  checkpointFor,
  jobNameFor,
  lifecycleConflict,
  runningCheckpointFor,
  runningCheckpointsOf,
  upsertCheckpoint,
  idFromJobName,
  JOB_PREFIXES,
  type LifecycleKind,
} from './checkpoints';
import { emitOne } from './emit';
import { tombstoneLiveSlot } from './reserve';
import type { SimCheckpoint } from './types';
import { simNow, type SimWorld } from './world';

export const DELETE_FIELD_JOB_PREFIX = JOB_PREFIXES.deleteField;
export const DELETE_MODEL_JOB_PREFIX = JOB_PREFIXES.deleteModel;

/**
 * What a deletion call reported.
 *
 * Three outcomes rather than two, and the middle one is the interesting one:
 * `deleted: false` with no error is the engine returning `false` because there
 * was nothing to do — the row does not exist, belongs to another tenant, or its
 * deletion is already in flight. **Those three are deliberately
 * indistinguishable**, which follows the tenant-isolation rule every entry point
 * observes and makes a repeated delete idempotent. The cost, and it is a real
 * one, is that a typo in an id is silent.
 */
export interface DeleteResult {
  world: SimWorld;
  deleted: boolean;
  /** Non-null only for a refusal — an overlapping lifecycle. */
  error: string | null;
}

/** A purge in flight: the checkpoint, and the partition it is draining. */
export interface PurgeProgress {
  kind: 'field' | 'model';
  /** Field id or model id, per `kind`. */
  targetId: number;
  label: string;
  checkpoint: SimCheckpoint;
  cursor: number;
  total: number;
}

/**
 * Every purge currently draining, of either kind, with its denominator.
 *
 * The same derivation `runningPromotions()` and `runningRenames()` do:
 * `backfill_checkpoints` stores a cursor and a status and nothing else.
 */
export function runningPurges(world: SimWorld): PurgeProgress[] {
  const out: PurgeProgress[] = [];

  for (const checkpoint of runningCheckpointsOf(world, 'deleteField')) {
    const fieldId = idFromJobName('deleteField', checkpoint.jobName);
    const field = world.fields.find(f => f.id === fieldId);
    // The claim's integrity predicate, as a read.
    if (field === undefined || field.deletedAt === null) continue;

    out.push({
      kind: 'field',
      targetId: fieldId,
      label: field.name,
      checkpoint,
      cursor: checkpoint.lastProcessedId,
      total: world.entries.filter(
        e => e.modelId === field.modelId && e.tenantId === world.tenantId,
      ).length,
    });
  }

  for (const checkpoint of runningCheckpointsOf(world, 'deleteModel')) {
    const modelId = idFromJobName('deleteModel', checkpoint.jobName);
    const model = world.models.find(m => m.id === modelId);
    if (model === undefined || model.deletedAt === null) continue;

    out.push({
      kind: 'model',
      targetId: modelId,
      label: model.name,
      checkpoint,
      cursor: checkpoint.lastProcessedId,
      // Counted live: unlike every other drain, this partition *shrinks* as it
      // is walked, because the chunks delete the rows they claim.
      total: world.entries.filter(
        e => e.modelId === modelId && e.tenantId === world.tenantId,
      ).length,
    });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Field deletion — ADR 0037
 * ------------------------------------------------------------------ */

/** `$stardust->deleteField($tenantId, $fieldId)`. */
export function deleteField(
  world: SimWorld,
  fieldId: number,
  correlationId: string,
): DeleteResult {
  const field = world.fields.find(f => f.id === fieldId);

  // Unknown, or already being deleted. Returned rather than refused — see
  // {@link DeleteResult}.
  if (field === undefined || field.deletedAt !== null) {
    return { world, deleted: false, error: null };
  }

  // **Refuse; do not cancel.** Deleting a field mid-backfill would strand a
  // `running` checkpoint no worker can ever claim: both sibling repositories
  // recover the field id by joining on a substring of `job_name`, so the row
  // becomes invisible to the daemon while still counting as running on any
  // dashboard. The `deleted_at` leg of this guard cannot fire — the check above
  // already returned for it.
  const conflict = lifecycleConflict(world, field);
  if (conflict !== null) return { world, deleted: false, error: conflict };

  const now = simNow(world);

  // 1. Sever. From this commit every registry reader excludes the row.
  //    `isFilterable` goes with it, and that half is load-bearing — see the
  //    file docblock.
  let next: SimWorld = {
    ...world,
    fields: world.fields.map(f =>
      f.id === fieldId ? { ...f, deletedAt: now, isFilterable: false, updatedAt: now } : f,
    ),
  };

  // 2. Hand any live slot to the Liberator. Nulls `field_id` first, which is
  //    what releases the RESTRICT foreign key for the final chunk's DELETE.
  //    Null for a JSON-only field, which under ADR 0034 is the common case.
  const tombstoned = tombstoneLiveSlot(next, fieldId);
  next = tombstoned.world;

  // 3. Terminal rename/retype rows. Both lifecycles are refused above while
  //    running, so these are `completed` or `failed` — harmless while the field
  //    exists, orphans the moment it does not.
  next = deleteTerminalLifecycleRows(next, [fieldId]);

  next = {
    ...next,
    schemaVersion: next.schemaVersion + 1,
    schemaVersionUpdatedAt: now,
  };

  next = upsertCheckpoint(next, 'deleteField', fieldId, now);

  return {
    world: emitOne(next, 'registry', 'delete_started', {
      correlation_id: correlationId,
      tenant_id: world.tenantId,
      model_id: field.modelId,
      field_id: fieldId,
      field_name: field.name,
      was_filterable: field.isFilterable,
      old_slot_assignment_id: tombstoned.slot?.id ?? null,
    }),
    deleted: true,
    error: null,
  };
}

/* ------------------------------------------------------------------ *
 * Model deletion — ADR 0038
 * ------------------------------------------------------------------ */

/**
 * `$stardust->deleteModel($tenantId, $modelId)`.
 *
 * **The only operation in the engine that physically deletes `entry_data`
 * rows, and there is no undelete.** Severance marks the model *and every field
 * it owns*, which is the whole economy of the feature: every existing
 * field-severance guard fires with zero new predicates.
 */
export function deleteModel(
  world: SimWorld,
  modelId: number,
  correlationId: string,
): DeleteResult {
  const model = world.models.find(m => m.id === modelId && m.tenantId === world.tenantId);
  if (model === undefined || model.deletedAt !== null) {
    return { world, deleted: false, error: null };
  }

  // Guards run before anything mutates, so a refused deletion changes nothing.
  // Fixed order — rename, retype, delete — asked of *any* field of the model.
  const conflict = modelLifecycleConflict(world, modelId);
  if (conflict !== null) return { world, deleted: false, error: conflict };

  const now = simNow(world);

  // Captured before the severance below clears them, because the tombstone loop
  // and the checkpoint cleanup both need the list.
  const fieldIds = world.fields
    .filter(f => f.modelId === modelId && f.deletedAt === null)
    .map(f => f.id);

  // 1 + 3. The model marker and every field's, together. The model marker is
  //        not redundant with the field ones: a fieldless model is legal, so a
  //        guard reading "no field of this model is live" is true of every
  //        brand-new model.
  let next: SimWorld = {
    ...world,
    models: world.models.map(m => (m.id === modelId ? { ...m, deletedAt: now } : m)),
    fields: world.fields.map(f =>
      f.modelId === modelId && f.deletedAt === null
        ? { ...f, deletedAt: now, isFilterable: false, updatedAt: now }
        : f,
    ),
  };

  // 4. Tombstone each field's live slot, by looping the shared tombstoner
  //    rather than re-deriving a set-based two-step: it is the index- and
  //    FK-defending sequence, and a duplicate of it is exactly what drifts.
  //    Bounded by field count — tens of rows, not millions.
  const tombstonedIds: number[] = [];
  for (const fieldId of fieldIds) {
    const result = tombstoneLiveSlot(next, fieldId);
    next = result.world;
    // A JSON-only field holds no slot at all under ADR 0034, which for a model
    // of ordinary fields is most of them — so this is usually a short list.
    if (result.slot != null) tombstonedIds.push(result.slot.id);
  }

  // 5. Every field-scoped checkpoint, all three namespaces. The `delete_field_`
  //    leg is reachable: a field purge manually marked failed leaves its row.
  next = deleteTerminalLifecycleRows(next, fieldIds);

  next = {
    ...next,
    schemaVersion: next.schemaVersion + 1,
    schemaVersionUpdatedAt: now,
  };

  // 7. **One** checkpoint, never one per field — N field purges would rewrite
  //    the same rows N times and never drop the model.
  next = upsertCheckpoint(next, 'deleteModel', modelId, now);

  return {
    world: emitOne(next, 'registry', 'model_delete_started', {
      correlation_id: correlationId,
      tenant_id: world.tenantId,
      model_id: modelId,
      model_name: model.name,
      field_count: fieldIds.length,
      slots_tombstoned: tombstonedIds.length,
    }),
    deleted: true,
    error: null,
  };
}

/**
 * Whether any field of the model has a lifecycle in flight.
 *
 * Deliberately not `lifecycleConflict()` per field: the messages name the
 * *model*, because that is what the caller asked to delete, and the third leg
 * here is a running field-*deletion* rather than a `deleted_at` marker — the
 * markers are exactly what this operation is about to set.
 */
function modelLifecycleConflict(world: SimWorld, modelId: number): string | null {
  const fieldIds = new Set(world.fields.filter(f => f.modelId === modelId).map(f => f.id));

  const legs: { kind: LifecycleKind; message: string }[] = [
    {
      kind: 'rename',
      message: `RenameInProgressException: Model ${modelId} has a field rename in flight; it cannot be deleted until the rename backfill completes.`,
    },
    {
      kind: 'retype',
      message: `RetypeInProgressException: Model ${modelId} has a field retype in flight; it cannot be deleted until the retype backfill completes.`,
    },
    {
      kind: 'deleteField',
      message: `FieldDeletionInProgressException: Model ${modelId} has a field deletion in flight; it cannot be deleted until that purge completes.`,
    },
  ];

  for (const leg of legs) {
    for (const checkpoint of runningCheckpointsOf(world, leg.kind)) {
      if (fieldIds.has(idFromJobName(leg.kind, checkpoint.jobName))) return leg.message;
    }
  }

  return null;
}

/**
 * Clear the field-scoped checkpoint rows for a set of fields, across all three
 * field namespaces.
 *
 * **This module is the only thing in `lib/sim/` that removes a checkpoint
 * row**, exactly as `src/Delete/` is the only thing in the engine's `src/` that
 * does. Every other lifecycle leaves an audit row keyed to a field that still
 * exists; here the field is about to be gone, so a surviving row is precisely
 * the orphan this feature eliminates.
 *
 * Scoped by exact job name, never a prefix scan, so it cannot reach another
 * field's rows.
 */
function deleteTerminalLifecycleRows(world: SimWorld, fieldIds: number[]): SimWorld {
  if (fieldIds.length === 0) return world;

  const doomed = new Set<string>();
  for (const fieldId of fieldIds) {
    doomed.add(jobNameFor('rename', fieldId));
    doomed.add(jobNameFor('retype', fieldId));
    doomed.add(jobNameFor('deleteField', fieldId));
  }

  return { ...world, checkpoints: world.checkpoints.filter(c => !doomed.has(c.jobName)) };
}

/** Whether a field-deletion purge is open for this field. */
export function runningFieldPurge(world: SimWorld, fieldId: number): SimCheckpoint | undefined {
  return runningCheckpointFor(world, 'deleteField', fieldId);
}

/** Whether a model purge is open. Also the answer to "is this model dark". */
export function runningModelPurge(world: SimWorld, modelId: number): SimCheckpoint | undefined {
  return runningCheckpointFor(world, 'deleteModel', modelId);
}

/** The checkpoint row for a field deletion, terminal states included. */
export function fieldPurgeCheckpoint(
  world: SimWorld,
  fieldId: number,
): SimCheckpoint | undefined {
  return checkpointFor(world, 'deleteField', fieldId);
}
