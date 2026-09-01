/**
 * The model under construction — the one piece of playground state that is
 * not a database table.
 *
 * `SchemaBuilder::createModel()` takes a model name and a list of
 * `FieldDefinition`s and commits them in one transaction. Everything a
 * visitor does before pressing "create model" is therefore *arguments*, not
 * rows, and it lives here rather than in {@link ./types.ts} — that file is a
 * mirror of the bootstrap DDL and a draft has no table behind it.
 *
 * It lives on the world rather than in component state for three reasons:
 * a half-built draft survives a refresh like everything else here; the guided
 * tour can script "add a field named city" through the same actions a human
 * uses; and validation stays in `lib/sim/` where every engine rule belongs.
 */

import type { DeclaredType } from './types';

/**
 * One row of the builder.
 *
 * `key` is a client-side identity for React and for drag tracking. It is
 * emphatically **not** a `stardust_fields.id` — the draft has no ids, because
 * nothing has been inserted yet. The registry id only exists after the commit.
 */
export interface DraftField {
  key: string;
  name: string;
  declaredType: DeclaredType;
  isFilterable: boolean;
}

/**
 * What a commit actually did — counts, not prose.
 *
 * It lives here rather than in `registry.ts` so that `SimDraft` can hold one
 * without the two modules importing each other, and because it is feedback
 * about a draft rather than a property of the registry.
 *
 * The interesting field is {@link versionBumped}. `createModel()` bumps
 * `stardust_schema_version` once per call and only when a row was really
 * inserted, so a re-run that finds everything already present bumps nothing —
 * and saying so out loud is the clearest way to show that get-or-create is
 * genuinely idempotent rather than merely tolerant.
 */
export interface CommitSummary {
  modelId: number;
  modelInserted: boolean;
  fieldsInserted: string[];
  /** Named in the draft, already present, and therefore left exactly as-is. */
  fieldsExisting: string[];
  versionBumped: boolean;
}

export interface SimDraft {
  /**
   * Set when the draft was re-opened from a committed model, so the UI can
   * say that pressing create again will resolve to the same row rather than
   * making a second model. Null for a fresh draft.
   */
  modelId: number | null;
  name: string;
  fields: DraftField[];
  /**
   * Populated by a rejected commit, cleared by the next edit. Carries the
   * engine's own message where the rule is the engine's.
   */
  error: string | null;
  /**
   * What the last commit of this draft did. Cleared by the next edit, because
   * it describes a state the draft has since moved away from.
   */
  lastCommit: CommitSummary | null;
  /**
   * Monotonic source of `key`. Draft-local rather than in `SimWorld.seq`,
   * which is strictly the database's auto-increments — and it means a reset
   * draft starts numbering from scratch, which a table's ids must never do.
   */
  nextKey: number;
}

export function emptyDraft(): SimDraft {
  return {
    modelId: null,
    name: '',
    fields: [],
    error: null,
    lastCommit: null,
    nextKey: 1,
  };
}

/**
 * `field_1`, `field_2`, … — the smallest suffix not already in the draft.
 *
 * A new row starts with a valid name rather than an empty one so the builder
 * never opens in an error state; the visitor renames it or leaves it.
 */
export function nextFieldName(fields: DraftField[]): string {
  const taken = new Set(fields.map(f => f.name));
  for (let n = 1; ; n++) {
    const candidate = `field_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
