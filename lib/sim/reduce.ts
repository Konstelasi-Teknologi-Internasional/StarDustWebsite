/**
 * The one reducer.
 *
 * State lives here rather than in per-section `useState`, because every
 * section of the playground reads what the previous one produced — a schema
 * defined in the first section has to still be there in the last one when a
 * field gets renamed under load. Anything else and the sections are four
 * unrelated demos again.
 *
 * Everything in this file is pure. React StrictMode double-invokes reducers in
 * development, so a reducer that logs, writes storage, or reads a module-level
 * counter produces a world that differs between dev and production. Side
 * effects belong in effects keyed on the result.
 */

import { advance, type DaemonName, type SpeedIndex } from './clock';
import { emptyDraft, nextFieldName, type DraftField } from './draft';
import {
  emptyPayloadDraft,
  nextUnknownKeyName,
  validatePayloadRows,
} from './payload';
import { createModel } from './registry';
import type { DeclaredType } from './types';
import {
  bulkWriteEntries,
  deleteEntry,
  payloadRowsFor,
  seedPayloads,
  toPayloadFields,
  writeEntry,
  SEED_COUNT,
} from './write';
import { emptyWorld, EVENT_LOG_LIMIT, fieldsOf, type SimWorld } from './world';

export type SimAction =
  /** Replace the world wholesale — snapshot restore, after mount. */
  | { type: 'world/hydrate'; world: SimWorld }
  | { type: 'world/reset' }
  | { type: 'clock/toggleRunning' }
  | { type: 'clock/tick' }
  | { type: 'clock/setSpeed'; speed: SpeedIndex }
  | { type: 'daemon/togglePaused'; daemon: DaemonName }
  /* ---- the model builder ---- */
  | { type: 'draft/setName'; name: string }
  /** `at` inserts; omitted appends. Drag passes an index, the palette does not. */
  | { type: 'draft/addField'; declaredType: DeclaredType; at?: number }
  | { type: 'draft/patchField'; key: string; patch: Partial<Omit<DraftField, 'key'>> }
  | { type: 'draft/removeField'; key: string }
  | { type: 'draft/moveField'; from: number; to: number }
  | { type: 'draft/reset' }
  /** Re-open a committed model, so pressing create again shows get-or-create. */
  | { type: 'draft/loadModel'; modelId: number }
  | { type: 'registry/createModel' }
  /* ---- the payload form ---- */
  | { type: 'payload/selectModel'; modelId: number }
  /** Keyed by field *name*: the rows are derived from the registry, not stored. */
  | { type: 'payload/setValue'; name: string; value: string }
  | { type: 'payload/addUnknownKey' }
  /** Only an unknown key can be renamed — a registered row *is* the model. */
  | { type: 'payload/renameKey'; key: string; name: string }
  | { type: 'payload/removeKey'; key: string }
  | { type: 'payload/reset' }
  /* ---- the write path ---- */
  | { type: 'entry/write' }
  | { type: 'entry/seed'; count?: number }
  | { type: 'entry/delete'; entryId: number };

/**
 * Per-daemon tick reducers, registered by name.
 *
 * Empty at this stage — the daemons themselves are a later stage — but the
 * seam is here so that adding one is a registration rather than a rewrite of
 * the tick path. Each will be `(world) => world`, pure, with its emitted
 * events appended to `world.events`.
 */
const DAEMON_REDUCERS: Partial<Record<DaemonName, (world: SimWorld) => SimWorld>> = {};

/**
 * The reducer proper.
 *
 * `capEvents` wraps the whole switch rather than sitting inside `clock/tick`,
 * where it started. That was correct while a tick was the only thing that
 * could emit; from the write path onward it is not, and a cap that a new case
 * has to remember to call is a cap that stops being one. The cost is an O(1)
 * length check per action.
 */
export function reduce(world: SimWorld, action: SimAction): SimWorld {
  return capEvents(apply(world, action));
}

function apply(world: SimWorld, action: SimAction): SimWorld {
  switch (action.type) {
    case 'world/hydrate':
      return action.world;

    case 'world/reset':
      return emptyWorld();

    case 'clock/toggleRunning':
      return { ...world, clock: { ...world.clock, running: !world.clock.running } };

    case 'clock/setSpeed':
      return { ...world, clock: { ...world.clock, speed: action.speed } };

    case 'daemon/togglePaused':
      return {
        ...world,
        clock: {
          ...world.clock,
          paused: {
            ...world.clock.paused,
            [action.daemon]: !world.clock.paused[action.daemon],
          },
        },
      };

    case 'draft/setName':
      return {
        ...world,
        draft: { ...world.draft, name: action.name, error: null, lastCommit: null },
      };

    case 'draft/addField': {
      const { draft } = world;
      const field: DraftField = {
        key: `d${draft.nextKey}`,
        name: nextFieldName(draft.fields),
        declaredType: action.declaredType,
        // Matching `stardust_fields.is_filterable NOT NULL DEFAULT FALSE`,
        // and `FieldDefinition`'s own `$isFilterable = false`. A field is
        // JSON-only unless someone asks for more.
        isFilterable: false,
      };
      const fields = [...draft.fields];
      fields.splice(action.at ?? fields.length, 0, field);
      return {
        ...world,
        draft: {
          ...draft,
          fields,
          error: null,
          lastCommit: null,
          nextKey: draft.nextKey + 1,
        },
      };
    }

    case 'draft/patchField': {
      const fields = world.draft.fields.map(f =>
        f.key === action.key ? { ...f, ...action.patch } : f,
      );
      return {
        ...world,
        draft: { ...world.draft, fields, error: null, lastCommit: null },
      };
    }

    case 'draft/removeField': {
      const fields = world.draft.fields.filter(f => f.key !== action.key);
      return {
        ...world,
        draft: { ...world.draft, fields, error: null, lastCommit: null },
      };
    }

    case 'draft/moveField': {
      const fields = [...world.draft.fields];
      const [moved] = fields.splice(action.from, 1);
      if (moved === undefined) return world;
      fields.splice(action.to, 0, moved);
      return {
        ...world,
        draft: { ...world.draft, fields, error: null, lastCommit: null },
      };
    }

    case 'draft/reset':
      return { ...world, draft: emptyDraft() };

    case 'draft/loadModel': {
      const model = world.models.find(m => m.id === action.modelId);
      if (model === undefined) return world;

      // Rebuilt from the registry rows in id order, because that *is* the
      // order — `stardust_fields` has no sort column. Whatever order the
      // draft was in when it was committed did not survive, and re-opening
      // it is where that becomes visible.
      let nextKey = 1;
      const fields = fieldsOf(world, model.id).map<DraftField>(f => ({
        key: `d${nextKey++}`,
        name: f.name,
        declaredType: f.declaredType,
        isFilterable: f.isFilterable,
      }));

      return {
        ...world,
        draft: {
          modelId: model.id,
          name: model.name,
          fields,
          error: null,
          lastCommit: null,
          nextKey,
        },
      };
    }

    case 'registry/createModel':
      return createModel(world, world.draft).world;

    /* ---------------- the payload form ---------------- */

    case 'payload/selectModel':
      // Values are keyed by field name and deliberately survive the switch: a
      // visitor who picked the wrong model, changed it, and lost everything
      // they had typed would have learned nothing about the engine.
      return patchPayload(world, draft => ({ ...draft, modelId: action.modelId }));

    case 'payload/setValue':
      return patchPayload(world, draft => ({
        ...draft,
        values: { ...draft.values, [action.name]: action.value },
      }));

    case 'payload/addUnknownKey':
      return patchPayload(world, draft => {
        const taken = [
          ...fieldsOf(world, draft.modelId ?? -1).map(f => f.name),
          ...draft.unknownKeys.map(u => u.name),
        ];
        return {
          ...draft,
          unknownKeys: [
            ...draft.unknownKeys,
            { key: `u${draft.nextKey}`, name: nextUnknownKeyName(taken) },
          ],
          nextKey: draft.nextKey + 1,
        };
      });

    case 'payload/renameKey':
      // Only unknown keys are in this list at all, so no guard is needed here:
      // a registered field's name is the registry's, and changing one is
      // `renameField()` — a migration over live data, not a form edit.
      return patchPayload(world, draft => {
        const target = draft.unknownKeys.find(u => u.key === action.key);
        if (target === undefined) return draft;
        return {
          ...draft,
          unknownKeys: draft.unknownKeys.map(u =>
            u.key === action.key ? { ...u, name: action.name } : u,
          ),
          // Carry the typed value across to the new name, or renaming a key
          // would silently blank it.
          values: renameValue(draft.values, target.name, action.name),
        };
      });

    case 'payload/removeKey':
      return patchPayload(world, draft => {
        const target = draft.unknownKeys.find(u => u.key === action.key);
        if (target === undefined) return draft;
        const values = { ...draft.values };
        delete values[target.name];
        return {
          ...draft,
          unknownKeys: draft.unknownKeys.filter(u => u.key !== action.key),
          values,
        };
      });

    case 'payload/reset': {
      const { modelId } = world.payloadDraft;
      return { ...world, payloadDraft: { ...emptyPayloadDraft(), modelId } };
    }

    /* ---------------- the write path ---------------- */

    case 'entry/write': {
      const draft = world.payloadDraft;
      const rows = payloadRowsFor(world, draft);

      const invalid = validatePayloadRows(draft.modelId, rows);
      if (invalid !== null) {
        return { ...world, payloadDraft: { ...draft, error: invalid, lastWrite: null } };
      }
      // Narrowed by validatePayloadRows, which rejects a null modelId.
      if (draft.modelId === null) return world;

      const result = writeEntry(world, draft.modelId, toPayloadFields(rows));
      return {
        ...result.world,
        payloadDraft: {
          ...draft,
          error: result.error,
          lastWrite: result.outcome,
          lastDelete: null,
        },
      };
    }

    case 'entry/seed': {
      const { modelId } = world.payloadDraft;
      if (modelId === null) return world;

      const count = action.count ?? SEED_COUNT;
      const result = bulkWriteEntries(world, modelId, seedPayloads(world, modelId, count));
      return {
        ...result.world,
        payloadDraft: {
          ...world.payloadDraft,
          error: result.error,
          // A seed is a batch, not this form's entry — leaving `lastWrite`
          // alone keeps the choreography from replaying against a row the
          // visitor never composed.
          lastWrite: null,
        },
      };
    }

    case 'entry/delete': {
      const result = deleteEntry(world, action.entryId);
      // `deleted: false` is the case worth carrying: the row does not change
      // and nothing is logged, so without this there is no way for a visitor
      // to observe that the second delete was a no-op rather than a failure.
      return {
        ...result.world,
        payloadDraft: {
          ...result.world.payloadDraft,
          lastDelete: { entryId: action.entryId, deleted: result.deleted },
        },
      };
    }

    case 'clock/tick': {
      const { clock, due } = advance(world.clock);
      return due.reduce<SimWorld>(
        (acc, name) => DAEMON_REDUCERS[name]?.(acc) ?? acc,
        { ...world, clock },
      );
    }
  }
}

/**
 * Edit the payload form, clearing the feedback from the last write.
 *
 * Same discipline as every `draft/*` case: an error or a result describes a
 * state the form has since moved away from, so an edit retires it.
 */
function patchPayload(
  world: SimWorld,
  patch: (draft: SimWorld['payloadDraft']) => SimWorld['payloadDraft'],
): SimWorld {
  const next = patch(world.payloadDraft);
  return {
    ...world,
    payloadDraft: { ...next, error: null, lastWrite: null, lastDelete: null },
  };
}

/** Move a typed value from one key to another, dropping it if it was empty. */
function renameValue(
  values: Record<string, string>,
  from: string,
  to: string,
): Record<string, string> {
  if (from === to) return values;
  const next = { ...values };
  const carried = next[from];
  delete next[from];
  if (carried !== undefined && carried !== '') next[to] = carried;
  return next;
}

/** Keeps the retained log bounded without the panel having to care. */
function capEvents(world: SimWorld): SimWorld {
  if (world.events.length <= EVENT_LOG_LIMIT) return world;
  return { ...world, events: world.events.slice(-EVENT_LOG_LIMIT) };
}
