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
import { chroniclerTick } from './daemons/chronicler';
import { liberatorTick } from './daemons/liberator';
import { reconcilerTick } from './daemons/reconciler';
import { watcherTick } from './daemons/watcher';
import { emptyDraft, nextFieldName, type DraftField } from './draft';
import { correlationId } from './emit';
import { demoteField, promoteField } from './retype';
import {
  emptyPayloadDraft,
  nextUnknownKeyName,
  validatePayloadRows,
} from './payload';
import {
  addLeaf,
  emptyQueryDraft,
  newLeaf,
  nodeAt,
  parseBuilderList,
  parseBuilderValue,
  replaceAt,
  retypeLeafValue,
  toggleGroupAt,
  wrapAt,
  type NodePath,
  type QueryDraft,
} from './query';
import { createModel } from './registry';
import { scenarioById, type ScenarioId } from './scenarios';
import { decodeFilter } from './filter/decode';
import { encodeEnvelope } from './filter/encode';
import { isLeaf, isRangeOperator, isSetOperator, type LeafNode, type LeafOperator } from './filter/ast';
import { runSearch } from './search/execute';
import type { SortDirection, SortSpec, SortTarget } from './search/sort';
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
  /** Replay a preset script. Replaces the world — every script opens on a reset. */
  | { type: 'scenario/load'; id: ScenarioId }
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
  | { type: 'entry/delete'; entryId: number }
  /* ---- the filterability lifecycle ---- */
  /** `$stardust->promoteFieldToFilterable($tenantId, $fieldId)`. */
  | { type: 'field/promote'; fieldId: number }
  /** `$stardust->demoteFieldFromFilterable($tenantId, $fieldId)`. */
  | { type: 'field/demote'; fieldId: number }
  /* ---- the query builder ---- */
  | { type: 'query/selectModel'; modelId: number }
  | { type: 'query/addCondition'; fieldName: string }
  | { type: 'query/setField'; path: NodePath; fieldName: string }
  | { type: 'query/setOperator'; path: NodePath; op: LeafOperator }
  /** `index` addresses one end of a `between` pair; omitted for every other. */
  | { type: 'query/setValue'; path: NodePath; text: string; index?: number }
  | { type: 'query/removeNode'; path: NodePath }
  | { type: 'query/wrap'; path: NodePath; kind: 'and' | 'or' | 'not' }
  | { type: 'query/toggleGroup'; path: NodePath }
  /** The visitor typed into the wire pane; the builder follows what decodes. */
  | { type: 'query/setWireText'; text: string }
  /** Hand the pane back to the builder, discarding hand-edited formatting. */
  | { type: 'query/syncWire' }
  | { type: 'query/setSort'; target: SortTarget; fieldName: string | null; direction: SortDirection }
  | { type: 'query/setPageSize'; size: number }
  /** `$stardust->search($request)` — always from the first page. */
  | { type: 'query/run' }
  | { type: 'query/nextPage' }
  | { type: 'query/prevPage' }
  | { type: 'query/reset' };

/**
 * Per-daemon tick reducers, registered by name.
 *
 * The seam stage 0 left open, now filled. Each is `(world) => world`, pure,
 * with its emitted events appended to `world.events` — which is what makes
 * step-one-tick and replay free rather than a special case.
 *
 * They are registered rather than called in sequence on purpose: `clock/tick`
 * asks the clock which daemons came due and folds only those, so a daemon's
 * poll period and its pause flag are the *only* things deciding whether it
 * runs. Nothing here knows the order they were written in, and no daemon reads
 * another's result — every interaction between them goes through the world,
 * which is the shared MySQL the landing page keeps insisting on.
 */
const DAEMON_REDUCERS: Partial<Record<DaemonName, (world: SimWorld) => SimWorld>> = {
  watcher: watcherTick,
  reconciler: reconcilerTick,
  liberator: liberatorTick,
  chronicler: chroniclerTick,
};

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

    /**
     * Fold a preset script through this same reducer.
     *
     * Not a hand-built world: a literal `SimWorld` would be a mirror of the
     * engine that nothing checks, and could express states no sequence of
     * actions can reach. Folding keeps every rule in one place and produces
     * the event log as a side effect of the actions rather than as decoration.
     *
     * Still pure, so StrictMode's double-invoke is harmless, and `simNow()`
     * derives from the tick rather than the wall clock — a replay is identical
     * every time. One dispatch is also one commit, so the snapshot effect
     * saves the parked world once rather than once per scripted action.
     */
    case 'scenario/load': {
      const scenario = scenarioById(action.id);
      if (scenario === undefined) return world;
      return scenario.actions.reduce(reduce, world);
    }

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

    /* ---------------- the filterability lifecycle ---------------- */

    case 'field/promote':
    case 'field/demote': {
      const intent = action.type === 'field/promote' ? 'promote' : 'demote';
      // The initiator is a caller, not a daemon, so its correlation id is
      // minted on the `api` source rather than a daemon's.
      const corrId = correlationId('api', world.clock.tick, world.seq.event);
      const result =
        intent === 'promote'
          ? promoteField(world, action.fieldId, corrId)
          : demoteField(world, action.fieldId, corrId);

      return {
        ...result.world,
        lastLifecycle: { fieldId: action.fieldId, action: intent, error: result.error },
      };
    }

    /* ---------------- the query builder ---------------- */

    case 'query/selectModel':
      // The tree names fields of a model, so switching models discards it.
      // Carrying it across would produce `field_unknown` on every leaf, which
      // is a true rejection about a filter the visitor did not write.
      return patchQuery(world, () => ({
        ...emptyQueryDraft(),
        modelId: action.modelId,
        pageSize: world.queryDraft.pageSize,
      }));

    case 'query/addCondition': {
      const model = world.models.find(m => m.id === world.queryDraft.modelId);
      if (model === undefined) return world;
      return patchQuery(world, draft => ({
        ...draft,
        tree: addLeaf(draft.tree, newLeaf(model.name, action.fieldName)),
      }));
    }

    case 'query/setField': {
      const leaf = leafAt(world.queryDraft, action.path);
      if (leaf === null) return world;
      const declaredType = declaredTypeFor(world, action.fieldName);
      // `prefix` survives only on a string field, matching the dropdown the
      // builder offers — see `operatorsFor()`.
      const op: LeafOperator =
        leaf.op === 'prefix' && declaredType !== 'string' ? 'eq' : leaf.op;
      return patchQuery(world, draft => ({
        ...draft,
        tree: replaceAt(draft.tree, action.path, {
          ...leaf,
          op,
          field: { ...leaf.field, name: action.fieldName },
        }),
      }));
    }

    case 'query/setOperator': {
      const leaf = leafAt(world.queryDraft, action.path);
      if (leaf === null) return world;
      return patchQuery(world, draft => ({
        ...draft,
        tree: replaceAt(draft.tree, action.path, retypeLeafValue(leaf, action.op)),
      }));
    }

    case 'query/setValue': {
      const leaf = leafAt(world.queryDraft, action.path);
      if (leaf === null) return world;
      const declaredType = declaredTypeFor(world, leaf.field.name);
      const value = nextLeafValue(leaf, action.text, action.index, declaredType);
      return patchQuery(world, draft => ({
        ...draft,
        tree: replaceAt(draft.tree, action.path, { ...leaf, value }),
      }));
    }

    case 'query/removeNode':
      return patchQuery(world, draft => ({
        ...draft,
        tree: replaceAt(draft.tree, action.path, null),
      }));

    case 'query/wrap':
      return patchQuery(world, draft => ({
        ...draft,
        tree: wrapAt(draft.tree, action.path, action.kind),
      }));

    case 'query/toggleGroup':
      return patchQuery(world, draft => ({
        ...draft,
        tree: toggleGroupAt(draft.tree, action.path),
      }));

    case 'query/setWireText': {
      // The pane is authoritative while it holds text, and the builder follows
      // whatever decodes — which is the round trip in the direction nobody
      // expects to work. A rejected edit keeps the previous tree, so the
      // builder does not empty itself while someone is halfway through typing.
      const decoded = decodeFilter(action.text);
      return {
        ...world,
        queryDraft: {
          ...world.queryDraft,
          wireText: action.text,
          wireError: decoded.ok ? null : decoded.error,
          tree: decoded.ok ? decoded.filter : world.queryDraft.tree,
          lastRun: null,
        },
      };
    }

    case 'query/syncWire':
      return {
        ...world,
        queryDraft: { ...world.queryDraft, wireText: null, wireError: null },
      };

    case 'query/setSort':
      return patchQuery(world, draft => ({
        ...draft,
        sortTarget: action.target,
        sortFieldName: action.fieldName,
        sortDirection: action.direction,
        // A cursor records the ordering it was issued under, so changing the
        // sort invalidates the walk. Dropping the tokens here is what the
        // engine's own advice — "restart pagination from the first page after
        // changing the sort" — looks like when the caller takes it.
        cursors: [],
      }));

    case 'query/setPageSize':
      return patchQuery(world, draft => ({ ...draft, pageSize: action.size, cursors: [] }));

    case 'query/run':
      return runQuery(world, []);

    case 'query/nextPage': {
      const token = world.queryDraft.lastRun?.outcome?.nextCursor ?? null;
      if (token === null) return world;
      return runQuery(world, [...world.queryDraft.cursors, token]);
    }

    case 'query/prevPage':
      return runQuery(world, world.queryDraft.cursors.slice(0, -1));

    case 'query/reset':
      return {
        ...world,
        queryDraft: { ...emptyQueryDraft(), modelId: world.queryDraft.modelId },
      };

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

/* ------------------------------------------------------------------ *
 * The query builder
 * ------------------------------------------------------------------ */

/**
 * Edit the filter, retiring what the last run said about it.
 *
 * The same discipline as `patchPayload()` and every `draft/*` case: a result
 * describes a filter the draft has since moved away from. It also hands the
 * wire pane back to the builder — an edit made through the builder is the
 * visitor saying the builder is the one they mean, and leaving hand-typed text
 * in place would make the panel show a filter their next click did not change.
 */
function patchQuery(world: SimWorld, patch: (draft: QueryDraft) => QueryDraft): SimWorld {
  const next = patch(world.queryDraft);
  return {
    ...world,
    queryDraft: { ...next, wireText: null, wireError: null, lastRun: null },
  };
}

/** The leaf at a path, or null if the path names a group or nothing. */
function leafAt(draft: QueryDraft, path: NodePath): LeafNode | null {
  const node = nodeAt(draft.tree, path);
  if (node === null || !isLeaf(node)) return null;
  return node;
}

/**
 * The declared type of a field by name, defaulting to `string`.
 *
 * The default is only reached for a name with no registry row — a filter on a
 * key the payload carries but `stardust_fields` does not — and such a leaf is
 * rejected at pre-flight with `field_unknown` long before its type matters.
 */
function declaredTypeFor(world: SimWorld, fieldName: string): DeclaredType {
  const modelId = world.queryDraft.modelId;
  if (modelId === null) return 'string';
  return fieldsOf(world, modelId).find(f => f.name === fieldName)?.declaredType ?? 'string';
}

/** One box's text, folded into whichever value shape the operator wants. */
function nextLeafValue(
  leaf: LeafNode,
  text: string,
  index: number | undefined,
  declaredType: DeclaredType,
): LeafNode['value'] {
  if (isSetOperator(leaf.op)) return parseBuilderList(text, declaredType);
  if (isRangeOperator(leaf.op)) {
    const current = Array.isArray(leaf.value) ? leaf.value : [];
    const pair = [current[0] ?? '', current[1] ?? ''];
    pair[index ?? 0] = parseBuilderValue(text, declaredType);
    return pair;
  }
  return parseBuilderValue(text, declaredType);
}

/**
 * The sort, as the engine's optional parameter.
 *
 * The default — id, ascending — resolves to `null` rather than to an explicit
 * spec, because that is the ordering every read had before ADR 0041 and null
 * is what emits a **v1** cursor. The two are interchangeable to the cursor's
 * mismatch check, which treats a v1 token and an explicit `$id`/asc as the
 * same ordering; mapping the default to null is what makes both token formats
 * appear in ordinary use rather than only under a deliberate choice.
 */
function sortSpecOf(draft: QueryDraft): SortSpec | null {
  if (draft.sortTarget === 'id' && draft.sortDirection === 'asc') return null;
  return {
    target: draft.sortTarget,
    fieldName: draft.sortTarget === 'field' ? draft.sortFieldName : null,
    direction: draft.sortDirection,
  };
}

/**
 * Run the query for a given cursor stack.
 *
 * **The envelope is always decoded before it executes**, even when the builder
 * produced it and nobody has typed a character. That is what makes the pane's
 * claim literal rather than decorative — the JSON on screen is the input, not
 * a rendering of one — and it means the decoder's own behaviour is visible in
 * ordinary use: an `in` list with a repeated element comes back deduplicated
 * because the decoder deduplicates it, not because the builder tidied up.
 */
function runQuery(world: SimWorld, cursors: string[]): SimWorld {
  const draft = world.queryDraft;
  if (draft.modelId === null) return world;

  const ranText = draft.wireText ?? encodeEnvelope(draft.tree);
  const decoded = decodeFilter(ranText);

  if (!decoded.ok) {
    return {
      ...world,
      queryDraft: {
        ...draft,
        cursors,
        wireError: decoded.error,
        lastRun: { outcome: null, rejection: null, wireError: decoded.error, ranText },
      },
    };
  }

  const corrId = correlationId('api', world.clock.tick, world.seq.event);
  const { world: next, result } = runSearch(
    world,
    {
      tenantId: world.tenantId,
      modelId: draft.modelId,
      filter: decoded.filter,
      sort: sortSpecOf(draft),
      pageSize: draft.pageSize,
      cursor: cursors[cursors.length - 1] ?? null,
    },
    corrId,
  );

  // A null rejection means the snapshot itself was missing — an unknown or
  // deleting model, which the model picker cannot currently produce. Leaving
  // the draft alone is the honest response: nothing ran, so nothing is
  // reported.
  if (!result.ok && result.rejection === null) return next;

  return {
    ...next,
    queryDraft: {
      ...draft,
      cursors,
      wireError: null,
      lastRun: {
        outcome: result.ok ? result.outcome : null,
        rejection: result.ok ? null : result.rejection,
        wireError: null,
        ranText,
      },
    },
  };
}

/** Keeps the retained log bounded without the panel having to care. */
function capEvents(world: SimWorld): SimWorld {
  if (world.events.length <= EVENT_LOG_LIMIT) return world;
  return { ...world, events: world.events.slice(-EVENT_LOG_LIMIT) };
}
