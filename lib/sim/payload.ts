/**
 * The entry under construction — the second member of `SimWorld` with no
 * table behind it.
 *
 * It lives on the world for the same three reasons {@link ./draft.ts} gives:
 * a half-filled payload survives a refresh like everything else here, the
 * guided tour can script "put 42 in employees" through the same actions a
 * human uses, and the rules stay in `lib/sim/` where every engine rule
 * belongs.
 *
 * ## It stores what was *typed*, not which fields exist
 *
 * The obvious shape — one row per field, each carrying its own name and
 * declared type — duplicates the registry, and a duplicate goes stale. It did:
 * a visitor who defined a model, came here, then went back and added a field
 * found the new field simply missing from this form, with nothing on screen to
 * say why. That breaks the promise the whole page is built on, which is that
 * every section reads the state the previous one produced.
 *
 * So the registry stays the single source of truth for *which fields exist*,
 * and this holds only the two things it is actually authoritative about: the
 * text typed into each box, and the keys the visitor invented. The rows are
 * derived — see `payloadRowsFor()` in {@link ./write.ts} — which makes the form
 * current by construction rather than by remembering to resynchronise it.
 *
 * **This module knows nothing about `SimWorld`**, and that is structural rather
 * than tidy: `world.ts` imports `emptyPayloadDraft()` to build its initial
 * state, so anything here that reached back for a world would be a runtime
 * import cycle. `draft.ts` is shaped the same way for the same reason.
 */

import type { DeclaredType } from './types';
import type { EntryWriteOutcome } from './write';

/**
 * A key the visitor added that the registry has never heard of.
 *
 * Not a novelty: an unknown key is stored verbatim in `entry_data.fields` and
 * reads back intact, which genuinely surprises people and is worth being able
 * to try. `key` is a client identity for React; it is emphatically not a
 * `stardust_fields.id`, because there is no such row.
 */
export interface UnknownKey {
  key: string;
  name: string;
}

/**
 * One row of the payload form, as rendered.
 *
 * Derived, never stored — `declaredType` is `null` exactly when the key is one
 * the visitor invented, and that `null` is the whole difference between "this
 * will be coerced into a slot one day" and "this is JSON, and only ever JSON".
 */
export interface PayloadRow {
  key: string;
  name: string;
  value: string;
  declaredType: DeclaredType | null;
  /** The `stardust_fields.id`, or `null` for an unknown key. */
  fieldId: number | null;
}

export interface SimPayloadDraft {
  modelId: number | null;
  /**
   * Field name → the raw text typed into its box. Keyed by name rather than by
   * id so an unknown key and a registered field share one map, and so a value
   * typed before a field existed is still there when it does.
   */
  values: Record<string, string>;
  unknownKeys: UnknownKey[];
  /** Set by a rejected write, cleared by the next edit. */
  error: string | null;
  /**
   * What the last write did, cleared by the next edit.
   *
   * The section's choreography keys on this object's **identity**, so the
   * initiator must hand back a new one per write — two writes of the same
   * payload have to be two distinguishable events.
   */
  lastWrite: EntryWriteOutcome | null;
  /**
   * The outcome of the last `deleteEntry()`, for the announcement.
   *
   * `deleted: false` is the interesting case and has no visual event of its
   * own — the row does not change, and nothing is logged. Without this the
   * section would claim in prose that a second delete is a silent no-op and
   * then give a visitor no way to observe it.
   */
  lastDelete: { entryId: number; deleted: boolean } | null;
  /** Monotonic source of an unknown key's `key`. Draft-local, like `SimDraft`. */
  nextKey: number;
}

export function emptyPayloadDraft(): SimPayloadDraft {
  return {
    modelId: null,
    values: {},
    unknownKeys: [],
    error: null,
    lastWrite: null,
    lastDelete: null,
    nextKey: 1,
  };
}

/** `unknown_1`, `unknown_2`, … — the smallest suffix not already in the form. */
export function nextUnknownKeyName(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const candidate = `unknown_${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Validate the form. `null` means valid.
 *
 * Both rules are the playground's, not the engine's, and the second is worth
 * spelling out: a payload is a JSON object, so two keys with the same name
 * cannot both survive encoding — the later one silently wins. Refusing that in
 * the form is clearer than showing a visitor a stored payload that quietly
 * dropped something they typed.
 */
export function validatePayloadRows(
  modelId: number | null,
  rows: PayloadRow[],
): string | null {
  if (modelId === null) {
    return 'Pick a model to write into first.';
  }

  const seen = new Set<string>();
  for (const row of rows) {
    if (row.name.trim() === '') {
      return 'A payload key cannot be empty.';
    }
    if (seen.has(row.name)) {
      return `Two keys in this payload are both named '${row.name}'. A JSON object cannot hold both, so the second would silently win.`;
    }
    seen.add(row.name);
  }

  return null;
}
