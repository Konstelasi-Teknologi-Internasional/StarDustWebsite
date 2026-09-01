'use client';

import { DAEMON_NAMES, SPEEDS, type SpeedIndex } from '@/lib/sim/clock';
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

  return (
    <div className={`panel ${styles.bar}`}>
      <div className={styles.group}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => dispatch({ type: 'clock/toggleRunning' })}
        >
          {clock.running ? 'pause' : 'run'}
        </button>

        <button
          type="button"
          className="btn"
          onClick={() => dispatch({ type: 'clock/tick' })}
          disabled={clock.running}
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
