'use client';

import { useState } from 'react';
import { SCENARIOS, type Scenario, type ScenarioId } from '@/lib/sim/scenarios';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { usePlayground } from './PlaygroundContext';
import styles from './ScenarioPicker.module.css';

/**
 * The picker, and the strip that explains what it parked you in.
 *
 * Two exports rather than one component, because they belong on opposite sides
 * of the clock bar's `position: sticky`. The buttons are a world control and
 * sit on the bar next to `reset world` — the control they most resemble, since
 * a scenario also replaces the world. The strip is three lines of prose and
 * would make the sticky bar tall enough to eat the screen on a phone, so it
 * renders below the bar and scrolls away with the page.
 *
 * Neither holds the loaded id: `ClockBar` owns it, so its existing reset button
 * can clear the strip in the same gesture that clears the world. What lives
 * here is `armed`, which is one button's confirm state and nothing else's
 * business.
 */

export function ScenarioButtons({ onLoad }: { onLoad: (id: ScenarioId) => void }) {
  const { world, hydrated } = usePlayground();
  const [armed, setArmed] = useState<ScenarioId | null>(null);

  // Before hydration the client renders `emptyWorld()` to match the server, so
  // reading the restored world any earlier is a mismatch. Un-hydrated therefore
  // reads as empty — which it is, on screen.
  const populated = hydrated && (world.models.length > 0 || world.entries.length > 0);

  function press(id: ScenarioId) {
    // A scenario replaces the world, and the visitor may have built something.
    // Two-step rather than `window.confirm`: same information, no dialog.
    if (populated && armed !== id) {
      setArmed(id);
      return;
    }
    setArmed(null);
    onLoad(id);
  }

  return (
    <div className={styles.buttons} role="group" aria-label="scenario presets">
      <span className={styles.label}>scenario</span>
      {SCENARIOS.map(scenario => (
        <button
          key={scenario.id}
          type="button"
          className={`${styles.load} ${armed === scenario.id ? styles.armed : ''}`}
          onClick={() => press(scenario.id)}
          title={
            armed === scenario.id
              ? 'This discards the world you have now'
              : scenario.blurb
          }
        >
          {armed === scenario.id ? 'replace world?' : scenario.title.toLowerCase()}
        </button>
      ))}
    </div>
  );
}

export function ScenarioStrip({
  scenario,
  onDismiss,
}: {
  scenario: Scenario;
  onDismiss: () => void;
}) {
  const reduced = useReducedMotion();

  return (
    <div className={`panel ${styles.strip}`} role="status">
      <div className={styles.stripHead}>
        <p className="eyebrow">parked</p>
        <button type="button" className={styles.dismiss} onClick={onDismiss}>
          dismiss
        </button>
      </div>
      <div className={styles.stripBody}>
        <h3 className={styles.stripTitle}>{scenario.title}</h3>
        <p className={styles.parked}>{scenario.parked}</p>
        <p className={styles.next}>
          <strong>Next:</strong>{' '}
          {/* Under reduced motion the clock cannot run itself, so an
              instruction to press run would be an instruction to press a
              disabled button. */}
          {reduced ? scenario.nextStepReduced : scenario.nextStep}{' '}
          <a href={scenario.anchor} className={styles.jump}>
            go to {scenario.anchorLabel} →
          </a>
        </p>
      </div>
    </div>
  );
}
