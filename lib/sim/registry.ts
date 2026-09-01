/**
 * The registry initiators — `SchemaBuilder`, simulated.
 *
 * Only `createModel()` exists at this stage. Rename, retype and delete are
 * initiators too and will land here beside it, but the engine's own rule
 * applies: don't build the seam until the phase that needs it.
 *
 * Written against `src/Schema/SchemaBuilder.php`. Three of its behaviours are
 * load-bearing here and easy to get subtly wrong:
 *
 *   1. **Every method is get-or-create.** A model or field whose name already
 *      exists is returned unchanged. Re-running a seed script is safe, which
 *      is the whole reason the helper exists.
 *   2. **Existing rows are NOT reconciled** against the arguments. Re-creating
 *      a model with a field whose `declared_type` differs keeps the *stored*
 *      type and silently ignores the argument. The real definition API will
 *      own migrations; this helper does not.
 *   3. **`stardust_schema_version` is bumped once per call, and only when
 *      something was actually inserted.** A no-op re-run bumps nothing.
 *
 * It provisions no page and reserves no slot. Marking a field filterable
 * writes `is_filterable = 1` to the registry and touches nothing else — which
 * is the gap the daemon section is built on.
 */

import type { CommitSummary, SimDraft } from './draft';
import type { DeclaredType, SimField, SimModel } from './types';
import { simNow, type SimWorld } from './world';

/** `stardust_fields.declared_type`, and `SchemaBuilder::DECLARED_TYPES`. */
export const DECLARED_TYPES: readonly DeclaredType[] = [
  'string',
  'int',
  'numeric',
  'datetime',
];

/** `VARCHAR(128)` on both `name` columns — `SchemaBuilder::NAME_MAX_LENGTH`. */
export const NAME_MAX_LENGTH = 128;

/**
 * Validate a draft the way the engine validates its arguments, plus one rule
 * that is ours.
 *
 * The first three messages are the engine's own `InvalidArgumentException`
 * text, reproduced verbatim, because a visitor who hits one here and then
 * hits it for real should see the same string.
 *
 * The duplicate-name check is **not** an engine rule and is labelled as such
 * below. `createModel()` would accept a repeated name without complaint: the
 * second `FieldDefinition` finds the row the first one just inserted, gets
 * its id back, and the `name → id` map collapses to a single entry. That is
 * silent deduplication rather than an error, and it makes for a confusing
 * builder, so the form refuses it. The engine does not.
 */
export function validateDraft(draft: SimDraft): string | null {
  if (draft.name.trim() === '') {
    return 'SchemaBuilder: model name must not be empty.';
  }
  if (draft.name.length > NAME_MAX_LENGTH) {
    return `SchemaBuilder: model name '${draft.name}' exceeds ${NAME_MAX_LENGTH} characters.`;
  }

  for (const field of draft.fields) {
    if (field.name.trim() === '') {
      return 'SchemaBuilder: field name must not be empty.';
    }
    if (field.name.length > NAME_MAX_LENGTH) {
      return `SchemaBuilder: field name '${field.name}' exceeds ${NAME_MAX_LENGTH} characters.`;
    }
    if (!DECLARED_TYPES.includes(field.declaredType)) {
      return `SchemaBuilder: declared_type '${field.declaredType}' is not one of ${DECLARED_TYPES.join(', ')}.`;
    }
  }

  // Ours, not the engine's — see the docblock.
  const seen = new Set<string>();
  for (const field of draft.fields) {
    if (seen.has(field.name)) {
      return `Two fields on this model are both named '${field.name}'. ux_fields_model_name is UNIQUE (model_id, name), so pick another.`;
    }
    seen.add(field.name);
  }

  return null;
}

export interface CommitResult {
  world: SimWorld;
  summary: CommitSummary | null;
}

/**
 * `$stardust->schemaBuilder()->createModel(...)`.
 *
 * Pure: takes a world, returns a new one. A rejected commit comes back with
 * `draft.error` set and every table untouched, which is what a thrown
 * `InvalidArgumentException` amounts to — the engine validates everything
 * before it opens its transaction, so a rejected call writes nothing.
 */
export function createModel(world: SimWorld, draft: SimDraft): CommitResult {
  const error = validateDraft(draft);
  if (error !== null) {
    return {
      world: { ...world, draft: { ...draft, error, lastCommit: null } },
      summary: null,
    };
  }

  const now = simNow(world);
  const name = draft.name;

  const models = [...world.models];
  const fields = [...world.fields];
  const seq = { ...world.seq };

  // `findModelId()` carries `deleted_at IS NULL`: a model whose purge is in
  // flight must not be handed back, or a re-run silently adopts a model whose
  // entries are being destroyed. Nothing can be deleting yet, but the
  // predicate is the behaviour, not the current state.
  let model = models.find(
    m => m.tenantId === world.tenantId && m.name === name && m.deletedAt === null,
  );

  let modelInserted = false;
  if (model === undefined) {
    model = {
      id: seq.model++,
      tenantId: world.tenantId,
      name,
      createdAt: now,
      deletedAt: null,
    } satisfies SimModel;
    models.push(model);
    modelInserted = true;
  }

  const fieldsInserted: string[] = [];
  const fieldsExisting: string[] = [];

  for (const draftField of draft.fields) {
    const existing = fields.find(
      f => f.modelId === model.id && f.name === draftField.name && f.deletedAt === null,
    );

    if (existing !== undefined) {
      // Deliberately no update. See behaviour 2 in the file docblock: a
      // changed declared_type or is_filterable on an existing field is
      // ignored, not applied.
      fieldsExisting.push(draftField.name);
      continue;
    }

    fields.push({
      id: seq.field++,
      modelId: model.id,
      name: draftField.name,
      declaredType: draftField.declaredType,
      isFilterable: draftField.isFilterable,
      previousName: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    } satisfies SimField);
    fieldsInserted.push(draftField.name);
  }

  const inserted = modelInserted || fieldsInserted.length > 0;

  const summary: CommitSummary = {
    modelId: model.id,
    modelInserted,
    fieldsInserted,
    fieldsExisting,
    versionBumped: inserted,
  };

  return {
    world: {
      ...world,
      models,
      fields,
      seq,
      // `UPDATE stardust_schema_version SET version = version + 1,
      // updated_at = ?` is one statement, so the timestamp moves with the
      // version or not at all. A no-op re-run touches neither.
      schemaVersion: inserted ? world.schemaVersion + 1 : world.schemaVersion,
      schemaVersionUpdatedAt: inserted ? now : world.schemaVersionUpdatedAt,
      // The draft is re-pointed at what it just committed rather than
      // cleared: the visitor can see what landed, and pressing create again
      // demonstrates get-or-create instead of making a second model.
      draft: { ...draft, modelId: model.id, error: null, lastCommit: summary },
    },
    summary,
  };
}
