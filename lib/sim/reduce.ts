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
import { emptyWorld, EVENT_LOG_LIMIT, type SimWorld } from './world';

export type SimAction =
  /** Replace the world wholesale — snapshot restore, after mount. */
  | { type: 'world/hydrate'; world: SimWorld }
  | { type: 'world/reset' }
  | { type: 'clock/toggleRunning' }
  | { type: 'clock/tick' }
  | { type: 'clock/setSpeed'; speed: SpeedIndex }
  | { type: 'daemon/togglePaused'; daemon: DaemonName };

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
