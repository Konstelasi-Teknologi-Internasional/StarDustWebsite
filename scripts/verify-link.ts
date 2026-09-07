/**
 * Hold a shared link to the one thing it claims: that opening it rebuilds the
 * world that produced it.
 *
 * Nothing else in this project can check that. A typecheck sees a codec whose
 * output feeds its own input and is satisfied; a build sees a component. The
 * failure this exists to catch is a *faithful-looking* link — one that decodes
 * cleanly, replays without error, and lands on a world subtly unlike the
 * sender's. A field that arrives non-filterable, a model whose id shifted by
 * one, six hundred rows that are the right count and the wrong values: all
 * three round-trip without throwing anything.
 *
 * So the check is an equality between two worlds rather than between two
 * strings. Build a world, derive its recipe, put the recipe through the actual
 * query string, replay it into a second world, and compare the tables the link
 * promises to carry — models, fields, and rows value for value.
 *
 * Four families of check, and each exists because a compiler cannot see it:
 *
 * 1. **Round trips**, above — for a hand-built schema, a preset and a tour
 *    cursor, which are the three things a link can be.
 * 2. **The honesty of the seed claim.** A world whose rows were not seeded must
 *    report itself in `unseeded` and travel without rows. Getting this wrong in
 *    the other direction is the worst failure available here: rows on a
 *    recipient's screen that nobody wrote, under someone else's name.
 * 3. **Decoding is defensive.** Every malformed link discards whole rather than
 *    replaying half a schema, because a half-replayed world is one the sender
 *    never had and the recipient cannot detect.
 * 4. **The link stays short.** The premise of carrying a recipe instead of a
 *    world is that the result survives a chat window. A regression here is
 *    silent until somebody's link is truncated by a mail client.
 *
 * Run with `npm run verify:link`.
 */

import {
  describeRecipe,
  fromQuery,
  recipeFor,
  toQuery,
  type LinkRecipe,
} from '../lib/sim/link';
import { reduce, type SimAction } from '../lib/sim/reduce';
import { SCENARIOS } from '../lib/sim/scenarios';
import { placesModel } from '../lib/sim/script';
import { TOUR } from '../lib/sim/tour';
import { emptyWorld, fieldsOf, type SimWorld } from '../lib/sim/world';

let failed = false;

function fail(message: string): void {
  failed = true;
  console.error(message);
}

function pass(message: string): void {
  console.log(`  ${message}`);
}

function fold(world: SimWorld, actions: SimAction[]): SimWorld {
  return actions.reduce(reduce, world);
}

/**
 * The whole trip, in the order the page makes it: derive, encode into a query
 * string, decode back out of it, fold.
 *
 * Going through `toQuery`/`fromQuery` rather than handing the recipe straight
 * to the reducer is the point — the string is where a link actually lives, and
 * a codec that only round-trips in memory is a codec that has not been tested.
 */
function shareAndOpen(
  world: SimWorld,
  source: { scenarioId: null | Parameters<typeof recipeFor>[1]['scenarioId']; stepIndex: number | null },
): { recipe: LinkRecipe; query: string; opened: SimWorld | null } {
  const { recipe } = recipeFor(world, source);
  const query = toQuery(recipe);
  const decoded = fromQuery(query);
  return {
    recipe,
    query,
    opened: decoded === null ? null : reduce(emptyWorld(), { type: 'link/load', recipe: decoded }),
  };
}

/** What the link promises to carry, and nothing else. */
function schemaOf(world: SimWorld): string {
  return JSON.stringify(
    world.models
      .filter(m => m.deletedAt === null)
      .map(model => [
        model.id,
        model.name,
        fieldsOf(world, model.id).map(f => [f.id, f.name, f.declaredType, f.isFilterable]),
      ]),
  );
}

function rowsOf(world: SimWorld): string {
  return JSON.stringify(
    world.entries
      .filter(e => e.deletedAt === null)
      .map(entry => [entry.id, entry.modelId, entry.fields]),
  );
}

/* ---------------- 1 · a hand-built schema ---------------- */

console.log('a hand-built schema');

const built = fold(emptyWorld(), placesModel());
const schema = shareAndOpen(built, { scenarioId: null, stepIndex: null });

if (schema.opened === null) {
  fail('✗ a schema link did not decode at all');
} else {
  if (schemaOf(schema.opened) !== schemaOf(built)) {
    fail(`✗ schema differs after a round trip\n    sent: ${schemaOf(built)}\n    got:  ${schemaOf(schema.opened)}`);
  } else {
    // Deliberately not claiming filterability: `placesModel()` commits three
    // non-filterable fields, so dropping the flag from the replay leaves this
    // check green. The two-model world below is where that is caught, and it
    // was added after a neuter check proved this one could not catch it.
    pass('✓ three fields and their declared types survive');
  }

  if (rowsOf(schema.opened) !== rowsOf(built)) {
    fail('✗ the 600 seeded rows are not reproduced value for value');
  } else {
    pass('✓ 600 seeded rows come back identical, ids included');
  }

  // The arithmetic `recipeActions` depends on, asserted rather than trusted.
  const ids = schema.opened.models.map(m => m.id);
  if (JSON.stringify(ids) !== JSON.stringify(ids.map((_, i) => i + 1))) {
    fail(`✗ model ids are not 1..n in commit order: ${JSON.stringify(ids)}`);
  } else {
    pass('✓ model ids land at 1..n, which is what the recipe addresses seeds by');
  }
}

/* A second model, because one model can never catch an id that shifts — and
   one *non-filterable* model can never catch a lost `is_filterable`. */

const twoModels = fold(built, [
  { type: 'draft/reset' },
  { type: 'draft/setName', name: 'regions' },
  { type: 'draft/addField', declaredType: 'string' },
  { type: 'draft/patchField', key: 'd1', patch: { name: 'label', isFilterable: true } },
  { type: 'draft/addField', declaredType: 'numeric' },
  { type: 'draft/patchField', key: 'd2', patch: { name: 'area' } },
  { type: 'registry/createModel' },
  { type: 'payload/selectModel', modelId: 2 },
  { type: 'entry/seed', count: 12 },
]);

const pair = shareAndOpen(twoModels, { scenarioId: null, stepIndex: null });
if (pair.opened === null) {
  fail('✗ a two-model link did not decode');
} else if (schemaOf(pair.opened) !== schemaOf(twoModels)) {
  fail('✗ two models do not survive a round trip');
} else if (rowsOf(pair.opened) !== rowsOf(twoModels)) {
  fail('✗ two models of rows do not survive a round trip');
} else {
  pass('✓ two models, 612 rows between them, and a filterable field on the second');
}

/* A name outside Latin-1, which is the case `btoa` alone would throw on. */

const unicode = fold(emptyWorld(), [
  { type: 'draft/setName', name: 'städte' },
  { type: 'draft/addField', declaredType: 'string' },
  { type: 'draft/patchField', key: 'd1', patch: { name: 'straße' } },
  { type: 'registry/createModel' },
]);
const encoded = shareAndOpen(unicode, { scenarioId: null, stepIndex: null });
if (encoded.opened === null || schemaOf(encoded.opened) !== schemaOf(unicode)) {
  fail('✗ a non-ASCII model name does not survive the base64url step');
} else {
  pass('✓ non-ASCII names survive (the UTF-8 step btoa alone would throw on)');
}

/* A model with no fields, which is legal and reachable — the create button has
   no guard, and the engine's own `createModel()` defaults `$fields` to `[]`.
   The decoder rejected it at first, which discarded the whole link rather than
   that one model: a visitor with one empty model and three real ones handed
   out a URL that decoded to nothing. */

const fieldless = fold(built, [
  { type: 'draft/reset' },
  { type: 'draft/setName', name: 'sketch' },
  { type: 'registry/createModel' },
]);
const fieldlessTrip = shareAndOpen(fieldless, { scenarioId: null, stepIndex: null });
if (fieldlessTrip.opened === null) {
  fail('✗ a world containing a fieldless model produces a link that decodes to nothing');
} else if (schemaOf(fieldlessTrip.opened) !== schemaOf(fieldless)) {
  fail('✗ a fieldless model does not survive alongside a real one');
} else {
  pass('✓ a fieldless model travels, and does not poison the models beside it');
}

/* The caps are a hostile-input guard, so they must still bite — and the sender
   has to be told when their own world trips one, or they copy a dead URL. */

const wide: SimAction[] = [{ type: 'draft/reset' }, { type: 'draft/setName', name: 'wide' }];
for (let i = 0; i < 70; i++) {
  wide.push({ type: 'draft/addField', declaredType: 'string' });
  wide.push({ type: 'draft/patchField', key: `d${i + 1}`, patch: { name: `f${i}` } });
}
wide.push({ type: 'registry/createModel' });

const overCap = recipeFor(fold(emptyWorld(), wide), { scenarioId: null, stepIndex: null });
if (overCap.travels) {
  fail('✗ a 70-field model reports as travelling, but the decoder caps fields at 64');
} else if (fromQuery(toQuery(overCap.recipe)) !== null) {
  fail('✗ the field cap no longer bites at all');
} else {
  pass('✓ a world past the field cap reports itself unshareable rather than handing over a dead link');
}

if (!recipeFor(twoModels, { scenarioId: null, stepIndex: null }).travels) {
  fail('✗ an ordinary two-model world reports itself unshareable — the check above proves nothing');
} else {
  pass('✓ an ordinary world still reports itself shareable');
}

/* ---------------- 2 · the seed claim ---------------- */

console.log('\nthe seed claim');

// Delete one row out of the middle of a seeded model. Every payload after it
// now sits against the wrong index, which is exactly the divergence the check
// has to notice — the row *count* alone would still look plausible.
const edited = fold(built, [{ type: 'entry/delete', entryId: 3 }]);
const editedDraft = recipeFor(edited, { scenarioId: null, stepIndex: null });

if (!editedDraft.unseeded.includes('places')) {
  fail('✗ a model with a deleted row is not reported as unseeded');
} else if (editedDraft.recipe.models.some(m => m.seed > 0)) {
  fail('✗ a model with a deleted row still carries a seed count');
} else {
  pass('✓ a hand-edited model reports itself unseeded and travels with no rows');
}

const editedOpened = shareAndOpen(edited, { scenarioId: null, stepIndex: null }).opened;
if (editedOpened === null) {
  fail('✗ an unseeded link did not decode');
} else if (editedOpened.entries.length !== 0) {
  fail(`✗ an unseeded link produced ${editedOpened.entries.length} rows nobody wrote`);
} else if (schemaOf(editedOpened) !== schemaOf(edited)) {
  fail('✗ an unseeded link lost the schema too');
} else {
  pass('✓ the schema still travels; the rows do not');
}

// The inverse: an untouched seeded model must not be reported unseeded, or the
// check above would pass by refusing everything.
const cleanDraft = recipeFor(built, { scenarioId: null, stepIndex: null });
if (cleanDraft.unseeded.length !== 0) {
  fail(`✗ an untouched seeded model reports as unseeded: ${cleanDraft.unseeded.join(', ')}`);
} else {
  pass('✓ an untouched seeded model is not reported unseeded');
}

/* ---------------- 3 · presets and the tour ---------------- */

console.log('\npresets and the tour cursor');

for (const scenario of SCENARIOS) {
  const parked = reduce(emptyWorld(), { type: 'scenario/load', id: scenario.id });
  const trip = shareAndOpen(parked, { scenarioId: scenario.id, stepIndex: null });

  if (trip.opened === null) {
    fail(`✗ ${scenario.id}: the link did not decode`);
    continue;
  }
  if (JSON.stringify(trip.opened) !== JSON.stringify(parked)) {
    fail(`✗ ${scenario.id}: the opened world is not the parked one`);
    continue;
  }
  if (!trip.query.includes(`scenario=${scenario.id}`)) {
    fail(`✗ ${scenario.id}: the link is not readable — ${trip.query}`);
    continue;
  }
  pass(`✓ ${scenario.id} round-trips to an identical world, on a readable link`);
}

// A cursor is a whole world, because every step builds on the reset in step 1.
// Checking the last step is what makes that claim load-bearing rather than
// true-by-luck at step 0.
for (const index of [0, 7, TOUR.length - 1]) {
  let walked: SimWorld = emptyWorld();
  for (let i = 0; i <= index; i++) walked = reduce(walked, { type: 'tour/step', index: i });

  const trip = shareAndOpen(walked, { scenarioId: null, stepIndex: index });
  if (trip.opened === null) {
    fail(`✗ step ${index + 1}: the link did not decode`);
  } else if (JSON.stringify(trip.opened) !== JSON.stringify(walked)) {
    fail(`✗ step ${index + 1}: the opened world is not the one the tour walks to`);
  } else if (trip.query !== `?step=${index}`) {
    fail(`✗ step ${index + 1}: the link is not readable — ${trip.query}`);
  } else {
    pass(`✓ step ${index + 1} of ${TOUR.length} reproduces the walked world`);
  }
}

// A tour cursor over a parked scenario shares the tour, not the scenario. The
// tour resets, so sharing the scenario there would describe a world nobody has
// been looking at since they pressed start.
const tourOverScenario = recipeFor(reduce(emptyWorld(), { type: 'scenario/load', id: 'warm-path' }), {
  scenarioId: 'warm-path',
  stepIndex: 4,
});
if (tourOverScenario.recipe.scenario !== null || tourOverScenario.recipe.step !== 4) {
  fail('✗ a running tour over a parked scenario shares the scenario');
} else {
  pass('✓ a running tour wins over a scenario parked before it started');
}

/* ---------------- 4 · defensive decoding ---------------- */

console.log('\nmalformed links');

const goodBlob = toQuery(recipeFor(built, { scenarioId: null, stepIndex: null }).recipe).slice(3);

function blob(wire: unknown): string {
  const json = JSON.stringify(wire);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const oneField = [['city', 'string', 0]];

const rejects: Array<[string, string]> = [
  ['not base64 at all', '?w=###'],
  ['base64 of something that is not JSON', `?w=${blob('nonsense').replace(/./, 'z')}`],
  ['a future wire version', `?w=${blob({ v: 99, m: [['places', 0, oneField]] })}`],
  ['no version at all', `?w=${blob({ m: [['places', 0, oneField]] })}`],
  ['no models', `?w=${blob({ v: 1, m: [] })}`],
  [
    'more fields than the cap',
    `?w=${blob({ v: 1, m: [['places', 0, Array.from({ length: 65 }, (_, i) => [`f${i}`, 'string', 0])]] })}`,
  ],
  [
    'more models than the cap',
    `?w=${blob({ v: 1, m: Array.from({ length: 13 }, (_, i) => [`m${i}`, 0, oneField]) })}`,
  ],
  [
    'two models of the same name',
    `?w=${blob({ v: 1, m: [['places', 0, oneField], ['places', 0, oneField]] })}`,
  ],
  [
    'two fields of the same name',
    `?w=${blob({ v: 1, m: [['places', 0, [['city', 'string', 0], ['city', 'int', 0]]]] })}`,
  ],
  ['a declared type that does not exist', `?w=${blob({ v: 1, m: [['places', 0, [['city', 'text', 0]]]] })}`],
  ['a filterable flag that is not a flag', `?w=${blob({ v: 1, m: [['places', 0, [['city', 'string', 2]]]] })}`],
  ['a seed larger than the page can produce', `?w=${blob({ v: 1, m: [['places', 5_000, oneField]] })}`],
  ['a fractional seed', `?w=${blob({ v: 1, m: [['places', 1.5, oneField]] })}`],
  ['an empty model name', `?w=${blob({ v: 1, m: [['   ', 0, oneField]] })}`],
  ['a name past VARCHAR(128)', `?w=${blob({ v: 1, m: [['x'.repeat(129), 0, oneField]] })}`],
  ['a blob past the length cap', `?w=${'A'.repeat(8_001)}`],
  ['an unknown scenario', '?scenario=the-one-that-got-away'],
  ['a negative step', '?step=-1'],
  ['a step that is not a number', '?step=3px'],
  ['a fractional step', '?step=2.5'],
  ['nothing at all', '?'],
  ['a parameter nobody reads', '?utm_source=mail'],
];

for (const [what, query] of rejects) {
  if (fromQuery(query) !== null) fail(`✗ accepted ${what}: ${query.slice(0, 60)}`);
}
pass(`✓ all ${rejects.length} malformed links decode to nothing rather than to half a world`);

// The positive control for the block above: the same shape, well-formed, must
// decode. Without it every rejection could be passing for the wrong reason.
if (fromQuery(`?w=${goodBlob}`) === null) {
  fail('✗ a well-formed blob was rejected — the checks above prove nothing');
} else {
  pass('✓ the well-formed blob those are variations of still decodes');
}

// Exclusivity, resolved most-specific-first rather than rejected.
const mixed = fromQuery(`?step=2&scenario=warm-path&w=${goodBlob}`);
if (mixed === null || mixed.step !== 2 || mixed.scenario !== null || mixed.models.length !== 0) {
  fail(`✗ a hand-edited link carrying all three does not resolve to the step: ${JSON.stringify(mixed)}`);
} else if (toQuery(mixed) !== '?step=2') {
  fail(`✗ re-encoding a resolved link is not a fixed point: ${toQuery(mixed)}`);
} else {
  pass('✓ a link carrying all three resolves to the step, and re-encodes to just that');
}

/* ---------------- 5 · the link stays short ---------------- */

console.log('\nsize');

const realistic = toQuery(recipeFor(twoModels, { scenarioId: null, stepIndex: null }).recipe);
if (realistic.length > 500) {
  fail(`✗ a two-model link is ${realistic.length} characters; the recipe has stopped being a recipe`);
} else {
  pass(`✓ two models and 612 rows travel in ${realistic.length} characters`);
}

if (describeRecipe(recipeFor(emptyWorld(), { scenarioId: null, stepIndex: null }).recipe) !== 'nothing yet') {
  fail('✗ an empty world does not describe itself as empty');
} else {
  pass('✓ an empty world says it has nothing to share');
}

console.log(failed ? '\nFAILED' : '\nall link checks green');
process.exit(failed ? 1 : 0);
