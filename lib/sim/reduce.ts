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
import { createModel } from './registry';
import type { DeclaredType } from './types';
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
  | { type: 'registry/createModel' };

/**
 * Per-daemon tick reducers, registered by name.
 *
 * Empty at this stage — the daemons themselves are a later stage — but the
 * seam is here so that adding one is a registration rather than a rewrite of
 * the tick path. Each will be `(world) => world`, pure, with its emitted
 * events appended to `world.events`.
 */
const DAEMON_REDUCERS: Partial<Record<DaemonName, (world: SimWorld) => SimWorld>> = {};

export function reduce(world: SimWorld, action: SimAction): SimWorld {
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

    case 'clock/tick': {
      const { clock, due } = advance(world.clock);
      const ticked = due.reduce<SimWorld>(
        (acc, name) => DAEMON_REDUCERS[name]?.(acc) ?? acc,
        { ...world, clock },
      );
      return capEvents(ticked);
    }
  }
}

/** Keeps the retained log bounded without the panel having to care. */
function capEvents(world: SimWorld): SimWorld {
  if (world.events.length <= EVENT_LOG_LIMIT) return world;
  return { ...world, events: world.events.slice(-EVENT_LOG_LIMIT) };
}
