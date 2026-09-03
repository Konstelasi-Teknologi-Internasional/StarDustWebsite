/**
 * `RenameInitiator` and `ModelRenamer`, simulated — ADR 0036.
 *
 * ## Why a field rename is a data migration and a model rename is one UPDATE
 *
 * `entry_data.fields` is keyed by field **name**. So flipping
 * `stardust_fields.name` changes what every stored payload in the model *should*
 * say, and none of what it does say. The rename is therefore a rewrite of every
 * row in the model — structurally a retype, except that it touches no slot at
 * all: no reservation, no tombstone, no Liberator hand-off, no coercion matrix,
 * and therefore no `capacity_wait` in the drain that follows.
 *
 * A model name is load-bearing nowhere by contrast. Identity is
 * `stardust_models.id`; `entry_data` carries `model_id`; no snapshot holds a
 * model name and no filter resolves through one. So `renameModel()` is one
 * UPDATE, synchronous and complete on return — and it deliberately does **not**
 * bump the schema version, which is the one thing here that reads as an
 * oversight unless you know why. Nothing a cached snapshot holds changes, and
 * `stardust_schema_version` is a singleton, so a bump would invalidate every
 * model's snapshot in every process for no correctness benefit.
 *
 * ## `previous_name` is the whole design
 *
 * The name flips immediately and the payloads are rewritten asynchronously, so
 * mid-drain some rows carry the old key and some the new. A non-null
 * `previous_name` means exactly **"a rename is in flight for this field"**, and
 * it lives on `stardust_fields` rather than on the checkpoint because the read
 * and write paths already read that table with no join — the alias rides along
 * free on both hot paths.
 *
 * ## Who bridges the window, and who deliberately does not
 *
 * | Surface | During the window |
 * | :-- | :-- |
 * | Read results | Falls back new key → old key |
 * | `write()` | Canonicalises **inbound** keys onto the new name |
 * | Filters | **Rejected on the old name. Not bridged, on purpose** |
 *
 * That asymmetry is the load-bearing decision. A rejected filter loses nothing
 * and tells the caller immediately; a rejected — or silently mis-keyed — write
 * loses data. So writes converge and filters fail loudly. It is free here:
 * the read snapshot is keyed by current name, so a filter on the old name
 * already resolves to nothing. Do not "fix" it.
 */

import { emitOne } from './emit';
import {
  jobNameFor,
  lifecycleConflict,
  runningCheckpointFor,
  upsertCheckpoint,
  JOB_PREFIXES,
} from './checkpoints';
import { NAME_MAX_LENGTH } from './registry';
// Type-only, so it erases at compile and adds no runtime edge: `InitiateResult`
// was first needed by the retype initiator and is the same two-field shape for
// all of them. A module of its own for one interface would be worse.
import type { InitiateResult } from './retype';
import type { SimCheckpoint, SimField } from './types';
import { simNow, type SimWorld } from './world';

export const RENAME_JOB_PREFIX = JOB_PREFIXES.rename;

/** A rename in flight: the checkpoint, and the partition it is rewriting. */
export interface RenameProgress {
  fieldId: number;
  previousName: string;
  currentName: string;
  checkpoint: SimCheckpoint;
  /** `last_processed_id` — an entry id, not a row count. */
  cursor: number;
  /** Rows in the partition. Derived here; no table stores it. */
  total: number;
}

/**
 * Every rename currently draining, with the denominator its progress is
 * measured against — the same derivation `runningPromotions()` does, and for
 * the same reason: `backfill_checkpoints` stores a cursor and a status and
 * nothing else, so a total belongs to whoever owns the partition.
 *
 * The partition carries **no `deleted_at` predicate**, matching the engine's
 * `fetchChunkIds()`: a soft-deleted entry can be read by nothing, but leaving
 * it on the stale key would desynchronise its payload from the registry for
 * good, and `deleted_at` is not a hard delete.
 */
export function runningRenames(world: SimWorld): RenameProgress[] {
  const out: RenameProgress[] = [];

  for (const checkpoint of world.checkpoints) {
    if (checkpoint.status !== 'running') continue;
    if (!checkpoint.jobName.startsWith(RENAME_JOB_PREFIX)) continue;

    const fieldId = Number(checkpoint.jobName.slice(RENAME_JOB_PREFIX.length));
    const field = world.fields.find(f => f.id === fieldId);
    // The claim's integrity predicate, as a read: a checkpoint whose bridge
    // marker was cleared has no old key to migrate from and is not claimable.
    if (field === undefined || field.previousName === null) continue;

    out.push({
      fieldId,
      previousName: field.previousName,
      currentName: field.name,
      checkpoint,
      cursor: checkpoint.lastProcessedId,
      total: world.entries.filter(
        e => e.modelId === field.modelId && e.tenantId === world.tenantId,
      ).length,
    });
  }

  return out;
}

/**
 * `$stardust->renameField($tenantId, $fieldId, $newName)`.
 *
 * Returns as soon as the registry commits; the payload rewrite is the
 * Reconciler's. There is deliberately **no "no backfill required" branch** — a
 * model with no entries simply completes on the work source's first tick.
 * Keeping the state machine uniform is worth more than short-circuiting the
 * empty case, and it means `previous_name` is always cleared by the same code.
 */
export function renameField(
  world: SimWorld,
  fieldId: number,
  rawName: string,
  correlationId: string,
): InitiateResult {
  const newName = rawName.trim();

  if (newName === '') {
    return { world, error: 'InvalidArgumentException: Field name must be a non-empty string.' };
  }
  if (newName.length > NAME_MAX_LENGTH) {
    return {
      world,
      error: `InvalidArgumentException: Field name exceeds ${NAME_MAX_LENGTH} characters.`,
    };
  }

  const field = world.fields.find(f => f.id === fieldId);
  if (field === undefined) {
    return { world, error: `FieldNotFoundException: Field ${fieldId} does not exist.` };
  }

  // Checked **before** the same-name no-op below, deliberately: re-issuing a
  // rename against a field that is being deleted is a mistake worth reporting,
  // not a no-op worth swallowing. Keyed on the registry column rather than on a
  // checkpoint, so it still fires for a purge whose checkpoint was cleared.
  if (field.deletedAt !== null) {
    return {
      world,
      error: `FieldDeletionInProgressException: Field ${fieldId} is being deleted; it cannot be renamed.`,
    };
  }

  // Idempotent no-op, matching `SchemaBuilder`'s get-or-create posture — and
  // ahead of the in-flight guards, so re-issuing the same rename mid-drain is
  // quiet rather than an error.
  if (newName === field.name) {
    return { world, error: null };
  }

  if (runningCheckpointFor(world, 'rename', fieldId) !== undefined) {
    return {
      world,
      error: `RenameInProgressException: Field ${fieldId} already has a rename in progress.`,
    };
  }
  const conflict = lifecycleConflict(world, field, 'rename');
  if (conflict !== null) return { world, error: conflict };

  const available = nameAvailable(world, field, newName);
  if (available !== null) return { world, error: available };

  const now = simNow(world);

  // One transaction: the flip, the bridge marker, the version bump, the
  // checkpoint. The bump matters here in a way it does not for a model rename —
  // a cached snapshot maps field *names*, and the one just invalidated is the
  // name every reader is about to need the fallback for.
  let next: SimWorld = {
    ...world,
    fields: world.fields.map(f =>
      f.id === fieldId ? { ...f, name: newName, previousName: field.name, updatedAt: now } : f,
    ),
    schemaVersion: world.schemaVersion + 1,
    schemaVersionUpdatedAt: now,
  };

  next = upsertCheckpoint(next, 'rename', fieldId, now);

  return {
    world: emitOne(next, 'registry', 'rename_started', {
      correlation_id: correlationId,
      tenant_id: world.tenantId,
      model_id: field.modelId,
      field_id: fieldId,
      old_name: field.name,
      new_name: newName,
    }),
    error: null,
  };
}

/**
 * The name must not collide with any **other** field's current name *or* its
 * in-flight `previous_name`.
 *
 * `ux_fields_model_name` covers only the first half, and the second half is the
 * subtle one. Renaming `a → b` frees `a` as far as that index is concerned, so a
 * subsequent `y → a` would be accepted — and then field `b`'s read fallback
 * (new key, else old key) would resolve to field `y`'s value on every row the
 * first backfill has not yet reached. Two fields, one key, no error.
 *
 * A clash against a *deleting* field is reported as a deletion rather than a
 * plain conflict, because the two need different responses: a conflict means
 * pick another name, this means wait for the Reconciler.
 */
function nameAvailable(world: SimWorld, field: SimField, newName: string): string | null {
  const clash = world.fields.find(
    f =>
      f.modelId === field.modelId &&
      f.id !== field.id &&
      (f.name === newName || f.previousName === newName),
  );

  if (clash === undefined) return null;

  if (clash.deletedAt !== null) {
    return (
      `FieldDeletionInProgressException: Field name '${newName}' is held by field ${clash.id}, ` +
      'which is being deleted; the name cannot be reused until its payload purge completes.'
    );
  }

  const reason =
    clash.name === newName
      ? `is already the name of field ${clash.id}`
      : `is the pre-rename name of field ${clash.id}, whose rename backfill has not finished`;

  return `FieldNameConflictException: Field name '${newName}' ${reason}.`;
}

/**
 * `$stardust->renameModel($tenantId, $modelId, $newName)`.
 *
 * One UPDATE, synchronous, complete on return. No checkpoint, no
 * `previous_name`, no window, and **no schema-version bump** — see the file
 * docblock. `verify:lifecycles` asserts the absence of that bump negatively, so
 * it cannot be "fixed" into existence by someone reaching for symmetry with
 * `renameField()`.
 *
 * The footgun this leaves behind is real and is the engine's, not ours:
 * `createModel()` is get-or-create keyed on `(tenant_id, name)`, so after a
 * rename a seed script still naming the old model creates a **second** one
 * rather than finding it. Inherent to get-or-create.
 */
export function renameModel(
  world: SimWorld,
  modelId: number,
  rawName: string,
  correlationId: string,
): InitiateResult {
  const newName = rawName.trim();

  if (newName === '') {
    return { world, error: 'InvalidArgumentException: Model name must be a non-empty string.' };
  }
  if (newName.length > NAME_MAX_LENGTH) {
    return {
      world,
      error: `InvalidArgumentException: Model name exceeds ${NAME_MAX_LENGTH} characters.`,
    };
  }

  const model = world.models.find(m => m.id === modelId && m.tenantId === world.tenantId);
  if (model === undefined) {
    return { world, error: `ModelNotFoundException: Model ${modelId} does not exist.` };
  }
  if (model.deletedAt !== null) {
    return {
      world,
      error: `ModelDeletionInProgressException: Model ${modelId} is being deleted; it cannot be renamed.`,
    };
  }

  // Returns before the transaction, which is what makes the engine's
  // `rowCount()` guard exact: a matched row is always a changed row.
  if (newName === model.name) return { world, error: null };

  const clash = world.models.find(
    m =>
      m.tenantId === world.tenantId &&
      m.id !== modelId &&
      m.name === newName &&
      m.deletedAt === null,
  );
  if (clash !== undefined) {
    return {
      world,
      error: `ModelNameConflictException: Model name '${newName}' is already the name of model ${clash.id}.`,
    };
  }

  const next: SimWorld = {
    ...world,
    models: world.models.map(m => (m.id === modelId ? { ...m, name: newName } : m)),
    // Deliberately no `schemaVersion` bump and no timestamp: `stardust_models`
    // has no `updated_at` column either, which is why the engine's ModelRenamer
    // is its one registry collaborator that takes no clock.
  };

  return {
    world: emitOne(next, 'registry', 'model_renamed', {
      correlation_id: correlationId,
      tenant_id: world.tenantId,
      model_id: modelId,
      old_name: model.name,
      new_name: newName,
    }),
    error: null,
  };
}

/** The job name a rename checkpoint carries. Re-exported for the work source. */
export function renameJobName(fieldId: number): string {
  return jobNameFor('rename', fieldId);
}
