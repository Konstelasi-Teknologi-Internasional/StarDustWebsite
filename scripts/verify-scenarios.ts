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

import { coalesce, milestonesSince, readPosition } from '../lib/sim/notify';
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

  // The feed coalesces **within one commit**, because that is the unit a
  // visitor perceives as a single moment — one `clock/tick` folds every due
  // daemon. Measuring it over the whole fold instead would report a collapse
  // the hook never performs, so this replays action by action and reports the
  // worst single commit, which is the only number the cap has to survive.
  let busiest = 0;
  let stepping = emptyWorld();
  for (const action of scenario.actions) {
    const mark = readPosition(stepping);
    stepping = reduce(stepping, action);
    busiest = Math.max(busiest, coalesce(milestonesSince(stepping, mark)).length);
  }

  console.log(
    `✓ ${scenario.id} — ${scenario.title}\n` +
      `    parked: ${scenario.actions.length} actions · tick ${world.clock.tick} · ` +
      `${world.models.length} model(s), ${world.entries.length} entries, ` +
      `${world.pages.length} page(s), ${world.slots.length} slots, ` +
      `${world.events.length} log lines\n` +
      `    narration: at most ${busiest} card(s) from any one commit`,
  );

  // Parking correctly and promising correctly are different claims. The strip
  // tells the visitor what happens when they click; this is that, run.
  let stageWorld = world;
  for (const stage of scenario.payoff) {
    // The read position, taken before the stage runs. `seq` is monotonic, so
    // this is the same one-number cursor the feed itself uses — the script and
    // the page therefore ask exactly the same question, rather than the script
    // approximating it.
    const mark = readPosition(stageWorld);

    stageWorld = stage.actions.reduce(reduce, stageWorld);
    const stageFailures = stage.assert(stageWorld);

    // A stage can fire exactly as asserted and narrate nothing, which on a
    // five-section page reads as nothing having happened. No other check here
    // can see that: they all read the world rather than what the visitor was
    // told about it.
    if (stage.narrates !== undefined) {
      const said = milestonesSince(stageWorld, mark).map(m => m.kind);
      for (const kind of stage.narrates) {
        if (!said.includes(kind)) {
          stageFailures.push(
            `expected the feed to say '${kind}', got [${said.join(', ') || 'nothing'}]`,
          );
        }
      }
    }

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
