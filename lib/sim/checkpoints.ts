/**
 * `backfill_checkpoints` and its four namespaces.
 *
 * One table, four lifecycles, and the engine treats them as one thing on
 * purpose: **all four `job_name` prefixes are exactly thirteen characters**, so
 * every claim query in `src/` shares `SUBSTRING(job_name, 14)` to recover the id
 * behind the row. That shared arithmetic is the reason this module exists rather
 * than a prefix constant sitting in each initiator.
 *
 * The second reason is a module cycle that would otherwise be unavoidable. A
 * field may have **one lifecycle in flight**, checked in one fixed order
 * everywhere — **rename → retype → delete** — so two concurrent initiators
 * cannot each see the other's row as absent. That means `rename.ts` must ask
 * whether a retype is running and `retype.ts` must ask whether a rename is, and
 * putting the answer in either module makes them import each other. It lives
 * here, where neither has to.
 *
 * ## One difference from the engine, and it is a hazard that does not port
 *
 * The engine's claim queries use `LIKE 'rename\_field\_%'` and had to be
 * escaped through `Support\LikePattern`, because `job_name` is operator-supplied
 * for Backfill Pump jobs and `_` is a single-character wildcard — verified on
 * MySQL 8.0.13, `deleteXmodelY_rebuild` matches the *unescaped* `delete_model_%`.
 * `String.prototype.startsWith` has no wildcards, so that hazard has no analogue
 * here and there is nothing to escape.
 *
 * What *does* port is the second half of that defence: each claim additionally
 * carries an **integrity predicate** no operator-named job could satisfy
 * (`previous_name IS NOT NULL` for a rename, `deleted_at IS NOT NULL` for the
 * two deletes). Those are reproduced at the work sources, because they are
 * joins against the registry rather than facts about the checkpoint row.
 */

import type { DeclaredType, SimCheckpoint, SimField } from './types';
import { simNow, type SimWorld } from './world';

/**
 * The four namespaces. **Every value here is thirteen characters** — the whole
 * `SUBSTRING(job_name, 14)` design rests on it, and `verify:lifecycles` asserts
 * it rather than trusting the eye. `delete_field_` and `delete_model_` diverge
 * at position 8, which is the only reason two prefixes this similar are safe.
 */
export const JOB_PREFIXES = {
  retype: 'retype_field_',
  rename: 'rename_field_',
  deleteField: 'delete_field_',
  deleteModel: 'delete_model_',
} as const;

/** Which lifecycle a checkpoint row belongs to. */
export type LifecycleKind = keyof typeof JOB_PREFIXES;

/** `rename_field_7`. */
export function jobNameFor(kind: LifecycleKind, id: number): string {
  return `${JOB_PREFIXES[kind]}${id}`;
}

/** `SUBSTRING(job_name, 14)`, cast to an id. */
export function idFromJobName(kind: LifecycleKind, jobName: string): number {
  return Number(jobName.slice(JOB_PREFIXES[kind].length));
}

export function checkpointFor(
  world: SimWorld,
  kind: LifecycleKind,
  id: number,
): SimCheckpoint | undefined {
  const jobName = jobNameFor(kind, id);
  return world.checkpoints.find(c => c.jobName === jobName);
}

/**
 * `existsRunningForField()`, as the row itself.
 *
 * **A terminal row is not protection.** This returns `undefined` for a
 * `completed` or `failed` checkpoint, which is exactly why every namespace
 * upserts rather than inserts — see {@link upsertCheckpoint}.
 */
export function runningCheckpointFor(
  world: SimWorld,
  kind: LifecycleKind,
  id: number,
): SimCheckpoint | undefined {
  const checkpoint = checkpointFor(world, kind, id);
  return checkpoint?.status === 'running' ? checkpoint : undefined;
}

/** Every running checkpoint of one namespace, oldest row first. */
export function runningCheckpointsOf(world: SimWorld, kind: LifecycleKind): SimCheckpoint[] {
  return world.checkpoints.filter(
    c => c.status === 'running' && c.jobName.startsWith(JOB_PREFIXES[kind]),
  );
}

/**
 * `insertOrReset()` — `INSERT … ON DUPLICATE KEY UPDATE`, for all four.
 *
 * Never a plain insert. Nothing removes a *completed* checkpoint for three of
 * the four namespaces, and `ux_backfill_job_name` is UNIQUE, so a second
 * lifecycle for the same field would throw a raw duplicate-key error on the
 * third call of promote → demote → promote. The running check above offers no
 * protection, because it reports false for a terminal row.
 *
 * `sourceDeclaredType` is reset along with the rest, and passing it is what
 * makes this one function rather than four. The engine's version of this is
 * deliberately *not* shared, and the note there is worth keeping: a retype that
 * reused a sibling's upsert would leave the second lifecycle draining against
 * the **first** one's source type — the wrong ADR 0024 matrix cell, with no
 * event and no exception. Here the column is a parameter, so the same mistake
 * would have to be made at the call site, in the open.
 */
export function upsertCheckpoint(
  world: SimWorld,
  kind: LifecycleKind,
  id: number,
  now: string,
  sourceDeclaredType: DeclaredType | null = null,
): SimWorld {
  const jobName = jobNameFor(kind, id);
  const existing = world.checkpoints.find(c => c.jobName === jobName);

  const row: SimCheckpoint = {
    id: existing?.id ?? world.seq.checkpoint,
    jobName,
    lastProcessedId: 0,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    lastError: null,
    sourceDeclaredType,
  };

  return {
    ...world,
    checkpoints:
      existing === undefined
        ? [...world.checkpoints, row]
        : world.checkpoints.map(c => (c.jobName === jobName ? row : c)),
    seq:
      existing === undefined
        ? { ...world.seq, checkpoint: world.seq.checkpoint + 1 }
        : world.seq,
  };
}

/** Advance a checkpoint's cursor, or close it out. Used by every work source. */
export function advanceCheckpoint(
  world: SimWorld,
  jobName: string,
  cursor: number,
  isFinalChunk: boolean,
): SimWorld {
  const now = simNow(world);
  return {
    ...world,
    checkpoints: world.checkpoints.map(c =>
      c.jobName === jobName
        ? {
            ...c,
            lastProcessedId: cursor,
            status: isFinalChunk ? ('completed' as const) : ('running' as const),
            updatedAt: now,
            completedAt: isFinalChunk ? now : null,
          }
        : c,
    ),
  };
}

/**
 * The lifecycle-exclusivity guard, in the engine's fixed order.
 *
 * **rename → retype → delete**, everywhere, so two initiators reaching for the
 * same field cannot each see the other's row as absent.
 *
 * The delete leg is checked differently from the other two on purpose: it keys
 * on `stardust_fields.deleted_at` rather than on a checkpoint row, so it still
 * fires for a field whose purge checkpoint was manually failed or deleted, where
 * a checkpoint-keyed guard would silently pass.
 *
 * Returns the engine's own exception text, or `null` when the field is free.
 * `exclude` lets an initiator skip its own leg — a rename initiator reports its
 * own in-flight rename with a message of its own wording.
 */
export function lifecycleConflict(
  world: SimWorld,
  field: SimField,
  exclude?: LifecycleKind,
): string | null {
  if (exclude !== 'rename' && runningCheckpointFor(world, 'rename', field.id) !== undefined) {
    return `RenameInProgressException: Field ${field.id} already has a rename in progress.`;
  }

  if (exclude !== 'retype' && runningCheckpointFor(world, 'retype', field.id) !== undefined) {
    return `RetypeInProgressException: Field ${field.id} has a retype in progress.`;
  }

  if (field.deletedAt !== null) {
    return `FieldDeletionInProgressException: Field ${field.id} is being deleted.`;
  }

  return null;
}
