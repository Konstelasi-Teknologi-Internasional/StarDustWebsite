/**
 * The action fragments every scripted world is built from.
 *
 * Two things drive the same simulation without a human: the scenario presets,
 * which fold a whole script into one commit to *park* a world, and the guided
 * tour, which dispatches the same actions a few at a time so each one can be
 * watched. They need the same fragments at different granularities, and the
 * one thing they must not do is hold two copies of the script.
 *
 * A copy would type-check forever. `SimAction` is a closed union, so a renamed
 * action breaks both at compile time — but a *reordered* one, or a fourth field
 * added to the model in one place and not the other, breaks neither. It shows
 * up as a scenario that still parks correctly and a tour that quietly walks a
 * different world, which is exactly the class of defect `verify:scenarios`
 * exists to catch and cannot catch here.
 *
 * So the fragments live here, in the granularity the *tour* needs — the finer
 * of the two — and `scenarios.ts` composes them back into the single prefix it
 * had. `verify:scenarios` proves that recomposition is unchanged: all three
 * parks still assert green on the same tick counts.
 *
 * **Nothing here reads a world.** These are literal action lists, so the module
 * imports `SimAction` as a type and has no runtime dependency on `reduce.ts` at
 * all — the same erasure `scenarios.ts` relies on to avoid a real cycle.
 */

import type { SimAction } from './reduce';

/**
 * The ids the scripted model commits with.
 *
 * Deterministic rather than looked up: a script runs from `world/reset`, and
 * `createModel()` assigns ids from 1 in draft order. Both consumers assert
 * against these, so a change to that ordering fails loudly instead of silently
 * promoting the wrong field.
 */
export const PLACES_MODEL = 1;
export const CITY = 1;
export const COUNTRY = 2;
export const POPULATION = 3;

/** `clock/tick` × n. */
export function ticks(n: number): SimAction[] {
  return Array.from({ length: n }, (): SimAction => ({ type: 'clock/tick' }));
}

/**
 * Name the draft and give it three fields.
 *
 * Every field is created non-filterable — which is `draft/addField`'s only
 * behaviour, matching `stardust_fields.is_filterable NOT NULL DEFAULT FALSE` —
 * so writes land in `jsonOnlyFields` and the sync queue stays empty. That
 * matters: a filterable field with no slot would route them into the ADR 0007
 * exhaustion path, where the Reconciler reserves an `assigned` slot and the
 * promotion window never happens at all.
 *
 * Draft keys are `d1`, `d2`, … — `nextKey` starts at 1 and a reset world has an
 * empty draft, so they are deterministic here.
 *
 * `population` is last on purpose. `seedPayloads` drops the *last* field on
 * every seventh row, so putting either string field there would leave ~86 rows
 * without the value the scripts are about.
 */
export function draftPlaces(): SimAction[] {
  return [
    { type: 'draft/setName', name: 'places' },
    { type: 'draft/addField', declaredType: 'string' },
    { type: 'draft/patchField', key: 'd1', patch: { name: 'city' } },
    { type: 'draft/addField', declaredType: 'string' },
    { type: 'draft/patchField', key: 'd2', patch: { name: 'country' } },
    { type: 'draft/addField', declaredType: 'int' },
    { type: 'draft/patchField', key: 'd3', patch: { name: 'population' } },
  ];
}

/** Commit the draft. Fields commit in draft order, so city = 1 … population = 3. */
export function commitPlaces(): SimAction[] {
  return [{ type: 'registry/createModel' }];
}

/**
 * Seed the batch. `entry/seed` reads `payloadDraft.modelId` rather than taking
 * one, so the model has to be selected first.
 *
 * 600 rows, which straddles the 500-row chunk. At 60 the whole backfill would
 * finish inside a single fold and there would be no window to stop in.
 */
export function seedPlaces(): SimAction[] {
  return [{ type: 'payload/selectModel', modelId: PLACES_MODEL }, { type: 'entry/seed' }];
}

/**
 * The shared prefix: a three-field model and 600 rows, nothing indexed.
 *
 * Always starts with `world/reset`, so a script ignores whatever world it was
 * loaded over — which is why both the picker and the tour warn before replacing
 * a populated one.
 */
export function placesModel(): SimAction[] {
  return [
    { type: 'world/reset' },
    ...draftPlaces(),
    ...commitPlaces(),
    ...seedPlaces(),
  ];
}

/** One leaf, one value, at the root — the filter both scripts run on `city`. */
export function filterCityIs(value: string): SimAction[] {
  return [
    { type: 'query/selectModel', modelId: PLACES_MODEL },
    { type: 'query/addCondition', fieldName: 'city' },
    // `addCondition` puts a single leaf at the root, so the path is empty.
    // It also defaults the value to '', which matches nothing — a filter left
    // that way would report zero rows and look like a broken payoff.
    { type: 'query/setValue', path: [], text: value },
    { type: 'query/run' },
  ];
}
