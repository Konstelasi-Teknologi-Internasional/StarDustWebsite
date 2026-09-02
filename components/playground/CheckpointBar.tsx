'use client';

import type { SimCheckpoint } from '@/lib/sim/types';
import styles from './CheckpointBar.module.css';

type Props = {
  checkpoint: SimCheckpoint;
  /**
   * How many rows the drain has to get through.
   *
   * **Supplied by the caller, never read off the checkpoint.**
   * `backfill_checkpoints` has no total-row column — the table stores a cursor
   * and a status and nothing else — so a denominator is something whoever owns
   * the partition derives, not something the row knows. Passing it in is what
   * keeps that honest; computing it inside would mean inventing a column.
   */
  total: number;
  /** Where the denominator came from, said out loud under the bar. */
  totalNote: string;
};

/**
 * One `backfill_checkpoints` row as a progress bar.
 *
 * Lifted from the landing page's `FieldLifecycle` as a **copy**, on the same
 * rule that produced `TableView` and `EventLog`: the home page is shipped and
 * working, and coupling four proven demos to a growing simulator trades a
 * stable asset for a convenience.
 *
 * Stage 0 deferred this extraction because the prop shape depended on a
 * checkpoint row that did not exist yet. It does now, and the shape that fell
 * out is the one above — a cursor plus a denominator the component is told
 * rather than one it assumes.
 */
export default function CheckpointBar({ checkpoint, total, totalNote }: Props) {
  const done = checkpoint.status === 'completed';
  // A completed checkpoint is complete even when the cursor sits below the
  // total, which is the normal ending: the final chunk is the one that came
  // back short, so the cursor stops at the last id it saw.
  const pct = done ? 100 : total === 0 ? 0 : Math.min(100, (checkpoint.lastProcessedId / total) * 100);

  return (
    <div className={styles.block}>
      <div className={styles.top}>
        <span className={styles.name}>
          backfill_checkpoints · <strong>{checkpoint.jobName}</strong>
        </span>
        <span className={`tag ${done ? 'tag-indexed' : 'tag-pending'}`}>
          <span className="dot" />
          {checkpoint.status}
        </span>
      </div>

      <div className={styles.track}>
        <div
          className={`${styles.fill} ${done ? styles.fillDone : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className={styles.foot}>
        <span>
          last_processed_id <strong>{checkpoint.lastProcessedId}</strong>
        </span>
        <span className={styles.note}>{totalNote}</span>
      </div>
    </div>
  );
}
