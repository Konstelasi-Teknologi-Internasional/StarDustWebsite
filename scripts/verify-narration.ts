/**
 * Drive every mapped milestone and check it is reachable, and says something.
 *
 * A sibling of `verify-scenarios.ts` rather than part of it, because it makes a
 * different claim. That one asks whether two scripted worlds park and pay off
 * where they promise; this one asks whether the eight entries in `notify.ts`'s
 * map can *occur at all* — which needs paths no scenario walks, an uncoercible
 * value and a single write among them.
 *
 * The regression it exists for is silent and invisible to `tsc`. A milestone
 * reads its payload by key (`entry_id`, `slot_column`, `field_id`), and those
 * keys are plain strings on an emit site in another module. Rename one and the
 * spec starts declining every line it is handed: no error, no failing type, no
 * missing event in the log — just a card that stopped appearing. Only two of
 * the eight are covered by a scenario's `narrates`, so without this the other
 * six could rot unnoticed.
 *
 * It also keeps one claim honest that this repo has already got wrong once: the
 * `dlq_inserted` burst is what justifies coalescing, in `notify.ts`'s docblock
 * and in the roadmap's traps. Asserting it is reachable is what stops that
 * being another plausible sentence nobody ran.
 *
 * Run with `npm run verify:narration`.
 */

import { MILESTONE_KINDS, milestonesSince, readPosition } from '../lib/sim/notify';
import { reduce, type SimAction } from '../lib/sim/reduce';
import { SCENARIOS } from '../lib/sim/scenarios';
import { emptyWorld, type SimWorld } from '../lib/sim/world';

const seen = new Set<string>();
let failed = false;

/**
 * Fold actions one at a time, collecting the milestones each commit produces.
 *
 * Per-commit rather than over the whole fold, because that is the unit the feed
 * consumes — and because a spec that only ever fires on the first line of a
 * batch would otherwise pass.
 */
function drive(label: string, actions: SimAction[], start?: SimWorld): SimWorld {
  let world = start ?? emptyWorld();

  for (const action of actions) {
    const mark = readPosition(world);
    world = reduce(world, action);

    for (const milestone of milestonesSince(world, mark)) {
      if (seen.has(milestone.kind)) continue;
      seen.add(milestone.kind);

      // Empty copy is a reachable milestone that still says nothing, which is
      // the failure this is guarding against wearing a different hat.
      if (milestone.headline.trim() === '' || milestone.detail.trim() === '') {
        console.error(`✗ ${milestone.kind} produced empty copy`);
        failed = true;
      }

      console.log(`  ✓ ${milestone.kind}  ·  ${label}  ·  → ${milestone.section}`);
      console.log(`      ${milestone.headline}`);
      console.log(`      ${milestone.detail}`);
    }
  }

  return world;
}

// The two scripted worlds, parked and paid off, cover five of the eight.
for (const scenario of SCENARIOS) {
  console.log(`\n${scenario.id}`);
  let world = drive(scenario.id, scenario.actions);
  for (const stage of scenario.payoff) {
    world = drive(scenario.id, stage.actions, world);
  }
}

/** A model with one promoted field and no page, so a write has nowhere to go. */
function oneFieldModel(declaredType: 'string' | 'int', name: string): SimAction[] {
  return [
    { type: 'world/reset' },
    { type: 'draft/setName', name: 'places' },
    { type: 'draft/addField', declaredType },
    { type: 'draft/patchField', key: 'd1', patch: { name } },
    { type: 'registry/createModel' },
    { type: 'field/promote', fieldId: 1 },
    { type: 'payload/selectModel', modelId: 1 },
  ];
}

// The ADR 0007 exhaustion path. Unreachable from the seed, which the roadmap's
// coalescing trap explains: `bulkWriteEntries` logs at chunk level, so six
// hundred rows produce two lines and no per-entry fallback at all.
console.log('\nsingle write into the exhaustion path');
drive('single write', [
  ...oneFieldModel('string', 'city'),
  { type: 'payload/setValue', name: 'city', value: 'aurora' },
  { type: 'entry/write' },
]);

// An uncoercible value. The write cannot fail — there is no slot to coerce
// into — so it lands in JSON and enqueues, and the failure happens later, when
// the Reconciler drains the queue into a slot the Watcher has provisioned.
console.log('\nuncoercible value into the DLQ');
drive('dlq', [
  ...oneFieldModel('int', 'population'),
  { type: 'payload/setValue', name: 'population', value: 'not-a-number' },
  { type: 'entry/write' },
  ...Array.from({ length: 12 }, (): SimAction => ({ type: 'clock/tick' })),
]);

console.log('');
for (const kind of MILESTONE_KINDS) {
  if (seen.has(kind)) continue;
  console.error(
    `✗ ${kind} is mapped in notify.ts but nothing here can produce it — ` +
      'either its payload keys no longer match the emit site, or this script ' +
      'needs a path that reaches it.',
  );
  failed = true;
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(`${MILESTONE_KINDS.length} milestones reachable.`);
}
