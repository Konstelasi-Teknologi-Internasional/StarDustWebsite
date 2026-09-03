/**
 * Fold every scenario headlessly and check it parks where it claims.
 *
 * A typed script catches a renamed or removed action at compile time, because
 * `apply()` has no default case and relies on exhaustiveness over `SimAction`.
 * What it cannot catch is a *moved precondition*: a poll period changes, or a
 * promotion takes one more tick to reserve, and the script still type-checks,
 * still runs to completion, and quietly parks somewhere else. Nothing fails —
 * the visitor is simply handed a world where the payoff has already happened,
 * or was never set up. That is what this checks.
 *
 * It lives here rather than as a runtime assertion in the reducer on purpose.
 * A throw during render unmounts the tree and takes the reset button with it,
 * which leaves devtools as the only way out of a bad world — the playground has
 * been there once already.
 *
 * Run with `npm run verify:scenarios`.
 */

import { reduce } from '../lib/sim/reduce';
import { SCENARIOS } from '../lib/sim/scenarios';
import { emptyWorld } from '../lib/sim/world';

let failed = false;

for (const scenario of SCENARIOS) {
  const nested = scenario.actions.filter(a => a.type === 'scenario/load');
  if (nested.length > 0) {
    // The fold is recursive, so this would work — and a scenario built out of
    // other scenarios would make the tick arithmetic in the comments a lie.
    console.error(`✗ ${scenario.id}: a script may not contain scenario/load`);
    failed = true;
    continue;
  }

  const world = scenario.actions.reduce(reduce, emptyWorld());
  const failures = scenario.assertParked(world);

  if (failures.length > 0) {
    failed = true;
    console.error(`✗ ${scenario.id} — ${scenario.title}`);
    for (const failure of failures) console.error(`    ${failure}`);
    continue;
  }

  console.log(
    `✓ ${scenario.id} — ${scenario.title}\n` +
      `    parked: ${scenario.actions.length} actions · tick ${world.clock.tick} · ` +
      `${world.models.length} model(s), ${world.entries.length} entries, ` +
      `${world.pages.length} page(s), ${world.slots.length} slots, ` +
      `${world.events.length} log lines`,
  );

  // Parking correctly and promising correctly are different claims. The strip
  // tells the visitor what happens when they click; this is that, run.
  let stageWorld = world;
  for (const stage of scenario.payoff) {
    stageWorld = stage.actions.reduce(reduce, stageWorld);
    const stageFailures = stage.assert(stageWorld);
    if (stageFailures.length > 0) {
      failed = true;
      console.error(`  ✗ payoff · ${stage.label}`);
      for (const failure of stageFailures) console.error(`        ${failure}`);
      // Stop this scenario rather than folding the rest onto a world that has
      // already diverged — every later stage would fail as a consequence and
      // bury the one that actually broke.
      break;
    }
    console.log(`    payoff · ${stage.label}`);
  }
}

if (failed) {
  console.error('\nA scenario does not park, or does not pay off, the way it says it does.');
  process.exitCode = 1;
} else {
  console.log(`\n${SCENARIOS.length} scenarios verified.`);
}
