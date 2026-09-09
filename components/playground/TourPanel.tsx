'use client';

import { useRef, useState } from 'react';
import { SECTION_LABELS } from '@/lib/sim/notify';
import type { TourStep } from '@/lib/sim/tour';
import { usePublishHeightVar } from '@/lib/usePublishHeightVar';
import { usePlayground } from './PlaygroundContext';
import styles from './TourPanel.module.css';

/**
 * The guided-tour dock, and the header toggle that starts it.
 *
 * Two exports rather than one component, on `ScenarioPicker`'s precedent and
 * for the same reason: they belong in different places on the page. The toggle
 * is a mode switch and sits in the header — the slot stage 5.5 deliberately
 * left uncommitted when it put the scenario picker on the clock bar instead.
 * The panel is fixed, because a tour whose next button scrolls out of view is
 * a tour that ends wherever the visitor stopped scrolling.
 *
 * Neither holds the cursor. `Playground` owns `stepIndex` — which is the mode,
 * since null is the sandbox — because the same gestures that clear a tour, reset
 * world and load a scenario, are already its. Component state rather than a member of `SimWorld` on the
 * picker's precedent: there is no column behind it, and a refresh landing in
 * the sandbox with the tour's world intact is the tour's own ending state
 * rather than a broken one.
 *
 * The panel takes a step and four callbacks and never sees a `SimWorld`. That
 * is the posture `EventLog` and `NarrationFeed` both hold: a component that
 * cannot reach the world cannot encode a rule about it.
 */

export function TourToggle({
  active,
  onStart,
  onExit,
}: {
  active: boolean;
  onStart: () => void;
  onExit: () => void;
}) {
  const { world, hydrated } = usePlayground();
  const [armed, setArmed] = useState(false);

  // Before hydration the client renders `emptyWorld()` to match the static
  // export, so reading the restored world any earlier is a mismatch.
  // Un-hydrated therefore reads as empty — which it is, on screen.
  const populated = hydrated && (world.models.length > 0 || world.entries.length > 0);

  function press() {
    // A segmented control: pressing the segment that is already selected does
    // nothing. Leaving a tour is the sandbox button beside it, or the panel's
    // own exit — never a second press on the thing you are already in.
    if (active) return;
    // The tour opens on `world/reset`, so starting one discards whatever the
    // visitor has built. Two-step rather than `window.confirm`: same
    // information, no dialog — the scenario buttons already work this way.
    if (populated && !armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    onStart();
  }

  return (
    <div className={styles.toggle} role="group" aria-label="playground mode">
      <button
        type="button"
        className={`${styles.mode} ${active ? styles.modeOn : ''} ${armed ? styles.armed : ''}`}
        aria-pressed={active}
        onClick={press}
        title={
          armed
            ? 'This discards the world you have now'
            : 'A scripted walk through the whole lifecycle, one step at a time'
        }
      >
        {armed ? 'replace world?' : 'guided'}
      </button>
      <button
        type="button"
        className={`${styles.mode} ${active ? '' : styles.modeOn}`}
        aria-pressed={!active}
        onClick={() => {
          setArmed(false);
          onExit();
        }}
        title="Every control unlocked, nothing scripted"
      >
        sandbox
      </button>
    </div>
  );
}

export function TourPanel({
  step,
  index,
  total,
  onNext,
  onRestart,
  onExit,
}: {
  step: TourStep;
  index: number;
  total: number;
  onNext: () => void;
  onRestart: () => void;
  onExit: () => void;
}) {
  const last = index === total - 1;

  const dockRef = useRef<HTMLDivElement | null>(null);
  // On a phone the dock spans the width and sits over whatever is behind it
  // — `--dock-h` is how `Playground.module.css` reserves that much space at
  // the foot of the page so the panel never covers the footer or the tail of
  // section F, only below the breakpoint where the dock actually overlaps.
  usePublishHeightVar(dockRef, '--dock-h');

  return (
    <div ref={dockRef} className={styles.dock}>
      <div className={`panel ${styles.panel}`} role="region" aria-label="Guided tour">
        <div className={styles.head}>
          <span className="eyebrow">
            guided · {index + 1} of {total}
          </span>
          <button type="button" className={styles.quiet} onClick={onExit}>
            exit
          </button>
        </div>

        {/* Progress as a bar rather than only as a fraction: the fraction says
            where you are and the bar says how much is left, which is the
            question a visitor deciding whether to start actually has. */}
        <div className={styles.progress} aria-hidden="true">
          <span className={styles.bar} style={{ width: `${((index + 1) / total) * 100}%` }} />
        </div>

        {/* One live region around the copy. The panel's frame does not change
            between steps; the two things that do are announced together, so a
            screen reader hears one sentence per press rather than three. */}
        <div className={styles.body} role="status">
          <p className={styles.where}>in {SECTION_LABELS[step.section]}</p>
          <h3 className={styles.title}>{step.title}</h3>
          <p className={styles.prose}>{step.body}</p>
        </div>

        <div className={styles.foot}>
          <button type="button" className="btn btn-primary" onClick={last ? onExit : onNext}>
            {last ? 'to the sandbox' : 'next'}
          </button>
          {/* There is no back: the reducer has no undo, and a world is a fold
              rather than a stack of diffs. Restarting replays from the reset,
              which is what stepping backwards would have to do anyway — so it
              says so instead of pretending otherwise. */}
          <button type="button" className={styles.quiet} onClick={onRestart}>
            restart
          </button>
        </div>
      </div>
    </div>
  );
}
