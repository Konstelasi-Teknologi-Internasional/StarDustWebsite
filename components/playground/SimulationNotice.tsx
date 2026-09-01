'use client';

import { REPO } from '@/lib/links';
import styles from './SimulationNotice.module.css';

/**
 * The label that keeps this page honest.
 *
 * There is no Node runtime, no PHP and no MySQL behind a static site, so the
 * playground cannot run the real engine — it is a hand-written simulation of
 * it. Saying so plainly costs nothing and is the difference between a
 * teaching tool and a page that quietly teaches something untrue.
 */
export default function SimulationNotice() {
  return (
    <aside className={`panel ${styles.notice}`}>
      <span className="tag tag-pending">
        <span className="dot" />
        simulation
      </span>
      <p>
        This page models the engine in the browser. It is not connected to a
        MySQL server, and no PHP runs anywhere — the rules it enforces were
        written by hand to match the engine&apos;s, and where the two ever
        disagree, <a href={REPO} target="_blank" rel="noreferrer">the engine is right</a>.
        Slot layouts, statuses, chunk sizes and event names are the real ones;
        row counts are scaled down to what a browser can hold.
      </p>
    </aside>
  );
}
