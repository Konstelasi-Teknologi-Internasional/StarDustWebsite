/**
 * Walk the guided tour headlessly and hold every step to what its copy claims.
 *
 * The tour is prose with a script attached, and prose is the part no compiler
 * checks. A renamed action fails `npm run typecheck`; a *moved precondition*
 * does not — a poll period changes, or a chunk size, and the tour still walks
 * to the end while step 9 tells a visitor about a 500-row chunk that was
 * actually 300. Every number and every event name spoken out loud in a step's
 * body is asserted in its `assert`, and this is what runs them.
 *
 * It drives `{ type: 'tour/step' }` through the real reducer rather than
 * folding `step.actions` directly, so the path under test is the one the panel
 * uses — including the bounds check.
 *
 * **The walk runs twice, from two very different starting worlds**, because
 * entering guided mode is a gesture a visitor makes over whatever they had
 * built. The tour opens on `world/reset` and therefore claims to be independent
 * of that; asserting the two passes hold identical worlds at every step is what
 * turns the claim into a check. It also settles the one step the
 * change-detection rule below cannot judge on its own: a reset over an empty
 * world is legitimately a no-op, and the same reset over a parked scenario is
 * the most consequential action in the file.
 *
 * Four structural checks sit alongside the per-step assertions, and each exists
 * because a typecheck cannot see it:
 *
 * 1. **Every act step changes the world**, in at least one pass, and every look
 *    step changes it in neither. A step whose actions have quietly become
 *    no-ops — `entry/seed` with no model selected, a filter run against a model
 *    that was never picked — still folds cleanly and leaves a visitor pressing
 *    next at a page that does nothing.
 * 2. **Every anchor is a real section**, so a step cannot scroll to an id that
 *    does not exist.
 * 3. **The tour visits all six**, which is the one claim the closing step makes
 *    that no single step's assertion can check.
 * 4. **Step ids are unique**, because they are React keys and the cursor's
 *    identity in the panel.
 *
 * Run with `npm run verify:tour`.
 */

import { FEED_SECTIONS, type FeedSection } from '../lib/sim/notify';
import { reduce, type SimAction } from '../lib/sim/reduce';
import { TOUR } from '../lib/sim/tour';
import { emptyWorld, type SimWorld } from '../lib/sim/world';

let failed = false;

function fail(message: string): void {
  failed = true;
  console.error(message);
}

/* ---------------- structure ---------------- */

const ids = new Set<string>();
for (const step of TOUR) {
  if (ids.has(step.id)) fail(`✗ duplicate step id '${step.id}'`);
  ids.add(step.id);
  if (!FEED_SECTIONS.includes(step.section)) {
    fail(`✗ ${step.id}: '${step.section}' is not a section anchor`);
  }
}

const visited = new Set<FeedSection>(TOUR.map(s => s.section));
for (const section of FEED_SECTIONS) {
  if (!visited.has(section)) fail(`✗ the tour never visits '${section}'`);
}

/* ---------------- the two walks ---------------- */

/**
 * The second starting world: a parked scenario, chosen because it is as unlike
 * an empty world as this playground gets — twelve ticks on the clock, a page,
 * sixteen slots, six hundred rows and a completed lifecycle behind it.
 */
const populated: SimWorld = reduce(emptyWorld(), { type: 'scenario/load', id: 'warm-path' });

let fresh: SimWorld = emptyWorld();
let over: SimWorld = populated;

TOUR.forEach((step, index) => {
  const action: SimAction = { type: 'tour/step', index };

  const beforeFresh = JSON.stringify(fresh);
  const beforeOver = JSON.stringify(over);
  fresh = reduce(fresh, action);
  over = reduce(over, action);
  const afterFresh = JSON.stringify(fresh);
  const afterOver = JSON.stringify(over);

  const changed = afterFresh !== beforeFresh || afterOver !== beforeOver;
  if (step.kind === 'act' && !changed) {
    fail(`✗ ${step.id}: an act step left the world untouched in both passes`);
    return;
  }
  if (step.kind === 'look' && changed) {
    fail(`✗ ${step.id}: a look step changed the world`);
    return;
  }

  // The tour opens on a reset, so from its first step the two passes are the
  // same world. Anything else means a step is reading state the tour did not
  // put there.
  if (afterFresh !== afterOver) {
    fail(`✗ ${step.id}: the two passes disagree — the tour depends on the world it started over`);
    return;
  }

  for (const pass of [fresh, over]) {
    const failures = step.assert(pass);
    if (failures.length > 0) {
      fail(`✗ ${index + 1}/${TOUR.length} ${step.id} — ${step.title}`);
      for (const failure of failures) console.error(`    ${failure}`);
      return;
    }
  }

  console.log(
    `✓ ${String(index + 1).padStart(2)}/${TOUR.length} ${step.id.padEnd(11)} ` +
      `${step.section.padEnd(8)} tick ${String(fresh.clock.tick).padStart(2)} · ` +
      `${fresh.entries.length} entries, ${fresh.pages.length} page(s), ` +
      `${fresh.slots.filter(s => s.status !== 'free').length} live slot(s), ` +
      `${fresh.events.length} log lines`,
  );
});

if (failed) {
  console.error('\nThe guided tour does not do what it says it does.');
  process.exit(1);
}

console.log(`\n${TOUR.length} tour steps verified, from two starting worlds.`);
