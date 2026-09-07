/**
 * The world, across a link.
 *
 * `persist.ts` is the same world across a *refresh*, and the two are
 * deliberately different mechanisms rather than one serialiser with two
 * outputs. A snapshot is a whole `SimWorld` — six hundred rows, two hundred log
 * lines, every slot and checkpoint — because `localStorage` does not care. A
 * URL does: past a few thousand characters it stops surviving the chat window,
 * the mail client and the address bar it has to travel through.
 *
 * So a link carries a **recipe, not a world**: the handful of things a visitor
 * actually authored, replayed through the same reducer on the other side. That
 * is only possible because two things are already true of this simulation, and
 * both are load-bearing here:
 *
 *   1. Every state change is a `SimAction` through `reduce()` (fidelity rule
 *      1), so a recipe can be expressed as actions rather than as data.
 *   2. `seedPayloads()` is deterministic — the same model and the same count
 *      produce the same six hundred rows, value for value — so a row count is
 *      a faithful stand-in for the rows themselves.
 *
 * Where (2) does not hold, the link says so rather than approximating. A model
 * whose rows were typed by hand, or seeded and then edited, comes back with its
 * schema and no rows, and {@link recipeFor} names it in `unseeded` so the share
 * panel can tell the sender before they send it. **Guessing here would be the
 * one failure the fidelity rules exist to prevent** — a recipient looking at
 * six hundred rows nobody wrote, in a table captioned as someone else's world.
 *
 * ## Three parameters, and only one of them is opaque
 *
 * `?scenario=warm-path` and `?step=6` are readable and hand-authorable on
 * purpose: the roadmap's open question 4 wants the home page's sections to deep
 * link into the matching playground step, and a base64 blob meaning "step 6"
 * would make that link unwritable by a human and unreviewable in a diff. Only
 * `?w=` — an arbitrary schema, which has no readable short form — is encoded.
 *
 * **All three are mutually exclusive, and the third one is why.** A preset is a
 * world *plus* a clock position, paused daemons and sometimes a lifecycle in
 * flight, none of which a schema recipe can express — so `scenario` and `w`
 * could not have been combined anyway. `step` is the sharper case: the tour's
 * first step is `world/reset` alone, and every step after it builds on the one
 * before, so a cursor position *is* a whole world and replaying it over a
 * shared schema would silently erase the schema. A link is therefore exactly
 * one of three things, and {@link fromQuery} resolves a hand-edited link
 * carrying several in the order step, scenario, schema — most specific first.
 *
 * ## Nothing here reads a browser
 *
 * `toQuery()` returns a query string and `fromQuery()` takes one, so the whole
 * codec is drivable from `node` and `npm run verify:link` exercises the exact
 * path the page uses. `window` is the component's business.
 */

import type { SimAction } from './reduce';
import { DECLARED_TYPES, NAME_MAX_LENGTH } from './registry';
import { SCENARIOS, type ScenarioId } from './scenarios';
import type { DeclaredType } from './types';
import { SEED_COUNT, seedPayloads } from './write';
import { fieldsOf, type SimWorld } from './world';

/**
 * The wire format's version, checked on decode and discarded on mismatch.
 *
 * The same rule `persist.ts` writes down and for the same reason: there is no
 * migration path, because a half-migrated world is the
 * returning-visitor-sees-a-crash failure. A link is worse than a snapshot in
 * one respect — it outlives the deploy that wrote it by however long the mail
 * sits unread — so a stale blob has to fail cleanly rather than nearly work.
 */
export const LINK_VERSION = 1;

/** The opaque schema recipe. */
export const PARAM_WORLD = 'w';
/** A preset, by id. Readable so a link can be written by hand. */
export const PARAM_SCENARIO = 'scenario';
/** A guided-tour cursor. Readable for the same reason. */
export const PARAM_STEP = 'step';

/**
 * Bounds on what a decoded link may ask for.
 *
 * A link arrives from outside and is applied before anyone has looked at it, so
 * these are the difference between "discard a malformed link" and "freeze the
 * tab a stranger sent you". `MAX_SEED` is `SEED_COUNT` rather than something
 * larger because one press of the seed button is what the page can produce, and
 * {@link recipeFor} can never derive more than that anyway — a world seeded
 * twice fails the fidelity check below and travels unseeded.
 */
const MAX_BLOB_LENGTH = 8_000;
const MAX_MODELS = 12;
const MAX_FIELDS_PER_MODEL = 64;
const MAX_STEP = 99;

export interface LinkField {
  name: string;
  declaredType: DeclaredType;
  isFilterable: boolean;
}

export interface LinkModel {
  name: string;
  fields: LinkField[];
  /**
   * How many rows to re-seed once the model is committed.
   *
   * Zero means "no rows travel", which covers both an empty model and one whose
   * rows could not be reproduced faithfully. The two are indistinguishable on
   * the wire on purpose: the recipient's world is the same either way, and the
   * sender was told the difference before they copied the link.
   */
  seed: number;
}

export interface LinkRecipe {
  scenario: ScenarioId | null;
  models: LinkModel[];
  step: number | null;
}

export interface RecipeDraft {
  recipe: LinkRecipe;
  /**
   * Whether the link this recipe produces decodes back into the same recipe.
   *
   * The caps above are a hostile-input guard, and a guard that only ever runs
   * on the *receiving* side turns a world larger than a cap into a link that
   * silently decodes to nothing — the sender sees a URL, copies it, and the
   * recipient lands on an empty playground with no way to tell that anything
   * was meant to be there.
   *
   * So the share panel asks the decoder about its own output before offering
   * it. This is deliberately a round trip rather than a count comparison
   * against the constants: it stays correct when a future cap is added, and it
   * is the only check that can fail for a reason nobody thought of.
   */
  travels: boolean;
  /**
   * The models whose rows the link cannot carry, by name.
   *
   * Not an error, and not a warning that the link is broken — it is the one
   * thing about a share the sender cannot see for themselves, because their own
   * screen shows the rows either way.
   */
  unseeded: string[];
}

/**
 * What this world would travel as.
 *
 * `scenarioId` and `stepIndex` are component state on the playground root
 * rather than members of `SimWorld` — neither has a column behind it — so they
 * are passed in rather than read off the world.
 */
export function recipeFor(
  world: SimWorld,
  source: { scenarioId: ScenarioId | null; stepIndex: number | null },
): RecipeDraft {
  // Most specific first, matching `fromQuery`. A running tour describes the
  // whole world on its own — it opened with a reset — so it needs neither of
  // the other two, and taking it first is also what stops a scenario that was
  // parked *before* the tour started from being shared as the world on screen.
  if (source.stepIndex !== null) {
    return {
      recipe: { scenario: null, models: [], step: source.stepIndex },
      unseeded: [],
      travels: true,
    };
  }

  if (source.scenarioId !== null) {
    return {
      recipe: { scenario: source.scenarioId, models: [], step: null },
      unseeded: [],
      travels: true,
    };
  }

  const models: LinkModel[] = [];
  const unseeded: string[] = [];

  for (const model of world.models) {
    // A model mid-purge is not a thing to hand somebody. Its rows are being
    // destroyed, `deleteModel()` has no undo, and the recipient would receive a
    // model that on their side was never deleted at all — a link reproducing
    // the schema and silently dropping the lifecycle it was showing.
    if (model.deletedAt !== null) continue;

    const fields = fieldsOf(world, model.id).map<LinkField>(field => ({
      name: field.name,
      declaredType: field.declaredType,
      isFilterable: field.isFilterable,
    }));

    const seed = seedCountFor(world, model.id);
    if (seed === null) unseeded.push(model.name);
    models.push({ name: model.name, fields, seed: seed ?? 0 });
  }

  const recipe: LinkRecipe = { scenario: null, models, step: null };
  return { recipe, unseeded, travels: models.length === 0 || survivesRoundTrip(recipe) };
}

/**
 * Does this recipe come back out of its own query string intact?
 *
 * Compared as JSON rather than field by field, because what matters is that
 * nothing was dropped — and a comparison written by hand would have to be kept
 * in step with the wire format by whoever changes it next.
 */
function survivesRoundTrip(recipe: LinkRecipe): boolean {
  const decoded = fromQuery(toQuery(recipe));
  return decoded !== null && JSON.stringify(decoded) === JSON.stringify(recipe);
}

/**
 * How many seeded rows this model has, or `null` if its rows are not seeded
 * rows at all.
 *
 * The check is exact rather than heuristic: regenerate the seed for the number
 * of live rows there are and compare it to what is stored, payload by payload.
 * Anything that moved — a hand-written entry, a deleted one, a field added
 * after the seed, a rename that rewrote the keys — changes at least one payload
 * and the model travels without rows.
 *
 * It is deliberately cheap to be wrong in this direction. A false `null` costs
 * the recipient one press of the seed button; a false count would put rows on
 * their screen that the sender never wrote.
 */
function seedCountFor(world: SimWorld, modelId: number): number | null {
  const live = world.entries.filter(e => e.modelId === modelId && e.deletedAt === null);
  if (live.length === 0) return 0;
  if (live.length > SEED_COUNT) return null;

  const expected = seedPayloads(world, modelId, live.length);
  for (let i = 0; i < live.length; i++) {
    const stored = live[i];
    const want = expected[i];
    if (stored === undefined || want === undefined) return null;
    if (!samePayload(stored.fields, want)) return null;
  }
  return live.length;
}

function samePayload(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * The recipe as actions, folded by `link/load` exactly the way `scenario/load`
 * folds a preset: one gesture, one commit, one snapshot save.
 *
 * **Model ids are arithmetic, not lookups.** The list opens with `world/reset`,
 * `createModel()` assigns from 1 in commit order, and decoding rejects a recipe
 * with two models of the same name — the case that would collapse two commits
 * onto one id, because the second call is a get-or-create that finds the first.
 * `script.ts` relies on the same determinism for `PLACES_MODEL = 1`, and
 * `verify:link` asserts it rather than trusting it.
 *
 * Draft keys are `d1`, `d2`, … for the same reason: `draft/reset` puts
 * `nextKey` back to 1, so the key of the field just added is its position.
 */
export function recipeActions(recipe: LinkRecipe): SimAction[] {
  if (recipe.step !== null) {
    // Every step from the beginning, not the one named. A tour step's actions
    // assume the steps before it ran — step 1 is the reset the rest are built
    // on — so folding step 7 alone would produce a world no visitor has ever
    // seen. This is the same walk the panel makes when someone presses next
    // seven times, which is why it needs no separate assertion of its own.
    // `tour/step` ignores an index past the end, so an over-long link folds
    // to the tour it has rather than to an error.
    return Array.from({ length: recipe.step + 1 }, (_, index): SimAction => ({
      type: 'tour/step',
      index,
    }));
  }

  if (recipe.scenario !== null) {
    return [{ type: 'scenario/load', id: recipe.scenario }];
  }

  const actions: SimAction[] = [{ type: 'world/reset' }];

  recipe.models.forEach((model, index) => {
    actions.push({ type: 'draft/reset' }, { type: 'draft/setName', name: model.name });

    model.fields.forEach((field, position) => {
      // `addField` is the engine's `is_filterable NOT NULL DEFAULT FALSE`; the
      // patch is the visitor ticking the box. Two actions rather than one
      // because that is the pair the builder dispatches, and a script taking a
      // shortcut the UI cannot take is a script testing another page.
      actions.push({ type: 'draft/addField', declaredType: field.declaredType });
      actions.push({
        type: 'draft/patchField',
        key: `d${position + 1}`,
        patch: { name: field.name, isFilterable: field.isFilterable },
      });
    });

    actions.push({ type: 'registry/createModel' });

    if (model.seed > 0) {
      // `entry/seed` reads `payloadDraft.modelId` rather than taking one.
      actions.push({ type: 'payload/selectModel', modelId: index + 1 });
      actions.push({ type: 'entry/seed', count: model.seed });
    }
  });

  return actions;
}

/** One line for the share panel: what the link on screen will reproduce. */
export function describeRecipe(recipe: LinkRecipe): string {
  const parts: string[] = [];

  if (recipe.step !== null) {
    parts.push(`the guided tour, walked to step ${recipe.step + 1}`);
  } else if (recipe.scenario !== null) {
    const scenario = SCENARIOS.find(s => s.id === recipe.scenario);
    parts.push(`the ${scenario?.title.toLowerCase() ?? recipe.scenario} preset`);
  } else if (recipe.models.length > 0) {
    const fields = recipe.models.reduce((n, m) => n + m.fields.length, 0);
    const rows = recipe.models.reduce((n, m) => n + m.seed, 0);
    parts.push(plural(recipe.models.length, 'model'));
    parts.push(plural(fields, 'field'));
    if (rows > 0) parts.push(`${rows.toLocaleString('en-GB')} seeded rows`);
  }

  return parts.length === 0 ? 'nothing yet' : parts.join(' · ');
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/* ---------------- the wire ---------------- */

/** The query string for a recipe, `?` included. Empty when it carries nothing. */
export function toQuery(recipe: LinkRecipe): string {
  const params = new URLSearchParams();

  // Same order as `fromQuery`, so a round trip is a fixed point even for a
  // recipe assembled by hand with more than one member set.
  if (recipe.step !== null) {
    params.set(PARAM_STEP, String(recipe.step));
  } else if (recipe.scenario !== null) {
    params.set(PARAM_SCENARIO, recipe.scenario);
  } else if (recipe.models.length > 0) {
    params.set(PARAM_WORLD, encodeModels(recipe.models));
  }

  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/**
 * A recipe from a query string, or `null` when there is nothing usable in it.
 *
 * Every read here is defensive and every failure resolves the same way —
 * discard — because the input is a URL somebody else wrote. A partially valid
 * link is treated as no link at all rather than as a smaller one: replaying
 * half a schema would hand the recipient a world the sender never had, and they
 * would have no way to know it.
 */
export function fromQuery(search: string): LinkRecipe | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }

  // Most specific first, and each read is skipped once something more
  // specific has answered — see the module docblock for why exactly one of
  // the three can apply. Skipping rather than rejecting keeps a hand-edited
  // link useful: `?scenario=warm-path&step=3` is somebody meaning one of the
  // two, and the tour is the one that describes a whole world.
  const step = decodeStep(params.get(PARAM_STEP));
  const scenario = step === null ? decodeScenario(params.get(PARAM_SCENARIO)) : null;
  const models =
    step === null && scenario === null ? decodeModels(params.get(PARAM_WORLD)) : null;

  if (step === null && scenario === null && models === null) return null;
  return { scenario, models: models ?? [], step };
}

function decodeScenario(raw: string | null): ScenarioId | null {
  if (raw === null) return null;
  const known = SCENARIOS.find(s => s.id === raw);
  return known === undefined ? null : known.id;
}

function decodeStep(raw: string | null): number | null {
  if (raw === null) return null;
  // `Number()` rather than `parseInt`, which would read '3px' as 3.
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_STEP) return null;
  return value;
}

/**
 * The blob: `{v, m:[[name, seed, [[name, type, filterable]]]]}`, base64url.
 *
 * Tuples rather than named keys because the blob is opaque and every byte is a
 * character somebody has to paste — but the declared type travels as its own
 * string rather than as an index into `DECLARED_TYPES`, so reordering that
 * array can never silently turn one type into another on the wire.
 */
type WireField = [string, string, number];
type WireModel = [string, number, WireField[]];

function encodeModels(models: LinkModel[]): string {
  const wire = {
    v: LINK_VERSION,
    m: models.map<WireModel>(model => [
      model.name,
      model.seed,
      model.fields.map<WireField>(f => [f.name, f.declaredType, f.isFilterable ? 1 : 0]),
    ]),
  };
  return toBase64Url(JSON.stringify(wire));
}

function decodeModels(raw: string | null): LinkModel[] | null {
  if (raw === null || raw.length === 0 || raw.length > MAX_BLOB_LENGTH) return null;

  const json = fromBase64Url(raw);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const wire = parsed as { v?: unknown; m?: unknown };
  if (wire.v !== LINK_VERSION) return null;
  if (!Array.isArray(wire.m) || wire.m.length === 0 || wire.m.length > MAX_MODELS) return null;

  const models: LinkModel[] = [];
  const modelNames = new Set<string>();

  for (const entry of wire.m) {
    if (!Array.isArray(entry) || entry.length !== 3) return null;
    const [name, seed, rawFields] = entry as [unknown, unknown, unknown];

    // Both uniqueness checks are what keeps `recipeActions`' id arithmetic
    // honest: a duplicate model name collapses two commits onto one id, and a
    // duplicate field name is refused by `validateDraft`, which leaves that
    // commit doing nothing and every id after it wrong.
    if (!isName(name) || modelNames.has(name)) return null;
    modelNames.add(name);

    if (!Number.isInteger(seed) || (seed as number) < 0 || (seed as number) > SEED_COUNT) {
      return null;
    }
    // A model with no fields at all is legal and reachable: the create button
    // has no guard, and the engine's own `createModel()` takes `$fields = []`
    // as its default. Rejecting it here discarded the *whole* link — a visitor
    // with one empty model and three real ones handed out a URL that decoded
    // to nothing and dropped the recipient on a first-visit tour.
    if (!Array.isArray(rawFields) || rawFields.length > MAX_FIELDS_PER_MODEL) {
      return null;
    }

    const fields: LinkField[] = [];
    const fieldNames = new Set<string>();

    for (const rawField of rawFields) {
      if (!Array.isArray(rawField) || rawField.length !== 3) return null;
      const [fieldName, declaredType, filterable] = rawField as [unknown, unknown, unknown];

      if (!isName(fieldName) || fieldNames.has(fieldName)) return null;
      fieldNames.add(fieldName);

      if (!isDeclaredType(declaredType)) return null;
      if (filterable !== 0 && filterable !== 1) return null;

      fields.push({ name: fieldName, declaredType, isFilterable: filterable === 1 });
    }

    models.push({ name, fields, seed: seed as number });
  }

  return models;
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= NAME_MAX_LENGTH;
}

function isDeclaredType(value: unknown): value is DeclaredType {
  return typeof value === 'string' && DECLARED_TYPES.includes(value as DeclaredType);
}

/**
 * base64url over UTF-8.
 *
 * `btoa` is a *byte* encoder and throws on anything above U+00FF, and both name
 * columns are `VARCHAR(128)` with no character-set rule in front of them — the
 * builder validates length and emptiness and nothing else — so a model called
 * `ciudades` is fine and one called `stadte` with an umlaut would throw without
 * the `TextEncoder` step. Padding is stripped because `=` is the one base64
 * character that has to be percent-escaped in a query string.
 */
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string | null {
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
