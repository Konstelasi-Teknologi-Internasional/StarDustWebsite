'use client';

import { useLayoutEffect, useRef } from 'react';
import { DAEMON_NAMES, SPEEDS, type SpeedIndex } from '@/lib/sim/clock';
import type { ScenarioId } from '@/lib/sim/scenarios';
import { useReducedMotion } from '@/lib/useReducedMotion';
import NowLine from './NowLine';
import { usePlayground } from './PlaygroundContext';
import { ScenarioButtons } from './ScenarioPicker';
import { ShareButton } from './ShareLink';
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
export default function ClockBar({
  onReset,
  onScenarioLoaded,
  shareOpen,
  onToggleShare,
}: {
  onReset: () => void;
  /**
   * Which preset was just parked. It lives on the root rather than here
   * because the strip that describes it is a sibling of this bar in the page
   * flow — the bar is `position: sticky`, and three lines of prose stuck under
   * the nav would eat a phone screen. The root also already owns the reset
   * that has to clear it.
   */
  onScenarioLoaded: (id: ScenarioId) => void;
  /**
   * The share panel's open state, owned by the root for the reason the
   * scenario strip's is: the panel it opens is a sibling of this bar in the
   * page flow, and `reset world` has to be able to close a panel describing a
   * world that no longer exists.
   */
  shareOpen: boolean;
  onToggleShare: () => void;
}) {
  const { world, dispatch } = usePlayground();
  const { clock } = world;
  const reduced = useReducedMotion();

  const barRef = useRef<HTMLDivElement | null>(null);

  /**
   * Publish this bar's real height as `--clockbar-h`, so every fixed offset
   * downstream — the section anchors' `scroll-margin-top`, `ModelBuilder`'s
   * sticky side column — reads it instead of guessing a pixel number.
   *
   * The guess used to live in five separate `.module.css` files as a bare
   * `124px` / `84px`, and it went stale the moment {@link NowLine} added its
   * second row: the bar got taller, nothing downstream noticed, and the
   * result was the sticky bar permanently overlapping the thing below it
   * rather than only on some viewport widths. `ResizeObserver` re-measures on
   * every cause of that — the daemon list wrapping, `NowLine`'s text
   * wrapping, a viewport resize — so the offset tracks the bar instead of a
   * snapshot of it.
   *
   * `useLayoutEffect`, not `useEffect`: it has to land before the browser
   * paints, or a downstream sticky element renders one frame at the stale
   * fallback and visibly jumps.
   */
  useLayoutEffect(() => {
    const el = barRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;

    const publish = () => {
      document.documentElement.style.setProperty('--clockbar-h', `${el.offsetHeight}px`);
    };

    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Which preset is parked, if any. Deliberately component state rather than a
  // member of `SimWorld`: it has no column behind it, and a reload landing on a
  // parked world with no strip is a correct world, not a broken one.
  return (
    <div ref={barRef} className={`panel ${styles.bar}`}>
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

      <ScenarioButtons
        onLoad={id => {
          // One dispatch, not one per scripted action: the whole script is
          // folded inside the reducer, so this is a single commit and a single
          // snapshot save.
          dispatch({ type: 'scenario/load', id });
          onScenarioLoaded(id);
        }}
      />

      <ShareButton open={shareOpen} onToggle={onToggleShare} />

      <button type="button" className={`btn ${styles.reset}`} onClick={onReset}>
        reset world
      </button>

      {/* A second row rather than a second bar. It is `width: 100%`, and the
          bar is `flex-wrap: wrap`, so it takes a line of its own without the
          bar needing to know it is there. */}
      <NowLine />
    </div>
  );
}
