'use client';

import { DAEMON_NAMES, SPEEDS, type SpeedIndex } from '@/lib/sim/clock';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { usePlayground } from './PlaygroundContext';
import styles from './ClockBar.module.css';

const SPEED_LABELS = ['0.5×', '1×', '2×'] as const;

/**
 * The clock, and the pause button that is the reason this page exists.
 *
 * Pausing an individual daemon lets a visitor stop the system mid-motion and
 * see it be honestly incomplete — a field marked filterable with no slot
 * behind it, a filter that is rejected for a reason they just caused. Nothing
 * else here can show that, so the per-daemon toggles are on the bar from the
 * start rather than hidden behind an advanced mode.
 */
export default function ClockBar({ onReset }: { onReset: () => void }) {
  const { world, dispatch } = usePlayground();
  const { clock } = world;
  const reduced = useReducedMotion();

  return (
    <div className={`panel ${styles.bar}`}>
      <div className={styles.group}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => dispatch({ type: 'clock/toggleRunning' })}
          // Under reduced motion the ticker never starts, so letting the clock
          // be marked running would strand the page: nothing advances, and the
          // step button below is the only thing that could. Disabled here so
          // that state cannot be entered at all — the note above the bar
          // already explains that step is how the walkthrough proceeds.
          disabled={reduced}
          title={
            reduced
              ? 'Reduced motion is on, so the clock does not run itself. Use step.'
              : undefined
          }
        >
          {clock.running ? 'pause' : 'run'}
        </button>

        <button
          type="button"
          className="btn"
          onClick={() => dispatch({ type: 'clock/tick' })}
          // The safety net for the same hazard. A world restored with
          // `running: true` cannot happen (`persist.ts` clears it), but a
          // future path that sets it under reduced motion would otherwise
          // leave nothing on this bar able to advance the clock.
          disabled={clock.running && !reduced}
          title="Advance exactly one tick"
        >
          step
        </button>

        <span className={styles.tick}>
          tick <strong>{clock.tick}</strong>
        </span>
      </div>

      <div className={styles.group} role="group" aria-label="clock speed">
        {SPEEDS.map((ms, i) => (
          <button
            key={ms}
            type="button"
            className={`${styles.speed} ${clock.speed === i ? styles.speedOn : ''}`}
            aria-pressed={clock.speed === i}
            onClick={() => dispatch({ type: 'clock/setSpeed', speed: i as SpeedIndex })}
          >
            {SPEED_LABELS[i]}
          </button>
        ))}
      </div>

      <div className={styles.daemons} role="group" aria-label="daemons">
        {DAEMON_NAMES.map(name => {
          const paused = clock.paused[name];
          return (
            <button
              key={name}
              type="button"
              className={`${styles.daemon} ${paused ? styles.daemonPaused : ''}`}
              aria-pressed={!paused}
              onClick={() => dispatch({ type: 'daemon/togglePaused', daemon: name })}
              title={
                paused
                  ? `${name} is stopped — it will not run on its poll period`
                  : `${name} polls every ${clock.periods[name]} ticks`
              }
            >
              <span className="dot" />
              {name}
            </button>
          );
        })}
      </div>

      <button type="button" className={`btn ${styles.reset}`} onClick={onReset}>
        reset world
      </button>
    </div>
  );
}
