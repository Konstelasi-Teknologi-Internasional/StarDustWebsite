/**
 * The clock every daemon runs on.
 *
 * Pure by construction: `advance()` takes a clock and returns a new one plus
 * the list of daemons whose poll period came due on that tick. Nothing here
 * schedules anything — the React layer owns the timer and calls in. That is
 * what makes step-one-tick free rather than a special case, and it is what
 * keeps the whole thing safe under StrictMode's double-invoke.
 *
 * Per-daemon pause flags exist from the start because pausing one daemon and
 * watching the system be honestly incomplete is the playground's signature
 * interaction, not a later refinement.
 */

export const DAEMON_NAMES = ['watcher', 'reconciler', 'liberator', 'chronicler'] as const;

export type DaemonName = (typeof DAEMON_NAMES)[number];

/**
 * Poll periods in ticks. The engine's real defaults are seconds apart and
 * differ per daemon; what matters for the demonstration is that they are
 * *different*, so the four visibly do not march in step — none of them reads
 * another's state, and every interaction goes through shared MySQL.
 */
export const DEFAULT_PERIODS: Record<DaemonName, number> = {
  watcher: 4,
  reconciler: 2,
  liberator: 3,
  chronicler: 5,
};

/** Milliseconds per tick at each speed setting. */
export const SPEEDS = [1600, 900, 450] as const;
export type SpeedIndex = 0 | 1 | 2;

export interface SimClock {
  tick: number;
  /** Whether the clock is auto-advancing. Stepping works either way. */
  running: boolean;
  speed: SpeedIndex;
  periods: Record<DaemonName, number>;
  paused: Record<DaemonName, boolean>;
}

export function initialClock(): SimClock {
  return {
    tick: 0,
    running: false,
    speed: 1,
    periods: { ...DEFAULT_PERIODS },
    paused: { watcher: false, reconciler: false, liberator: false, chronicler: false },
  };
}

export function tickMs(clock: SimClock): number {
  return SPEEDS[clock.speed];
}

/**
 * Advance one tick.
 *
 * `due` is the daemons that should run this tick: period came round, and the
 * daemon is not individually paused. A paused daemon does not accumulate a
 * backlog of missed polls — it simply does not run, exactly like a process
 * that is not started.
 */
export function advance(clock: SimClock): { clock: SimClock; due: DaemonName[] } {
  const tick = clock.tick + 1;
  const due = DAEMON_NAMES.filter(
    name => !clock.paused[name] && tick % clock.periods[name] === 0,
  );
  return { clock: { ...clock, tick }, due };
}
