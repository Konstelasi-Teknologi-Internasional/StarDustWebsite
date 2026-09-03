'use client';

import { DAEMON_NAMES } from '@/lib/sim/clock';
import { runningPromotions } from '@/lib/sim/retype';
import { usePlayground } from './PlaygroundContext';
import styles from './NowLine.module.css';

/**
 * What the world is doing, continuously.
 *
 * The other half of stage 5.6, and the half the feed cannot do. A milestone
 * fires at a boundary — a page appears, a slot flips — and between two of them
 * a six-hundred-row backfill can drain for three ticks with nothing to
 * announce. This is the stretch in between, and it sits on the clock bar
 * because that bar is already sticky and already the world-control surface: it
 * follows the visitor down all five sections for free.
 *
 * **Every figure is the length of a real array or the value of a real
 * cursor.** No estimates, no scaling — the same rule the seed panel and the
 * shared-state grid follow, and the reason this shows `500/600` rather than a
 * percentage of something nobody can point at.
 *
 * It is deliberately **not** an `aria-live` region. It changes on every tick,
 * and announcing that is a screen-reader firehose. The feed is the live
 * region; this is a readout you look at.
 */
export default function NowLine() {
  const { world } = usePlayground();

  // No `hydrated` guard on any of these, deliberately and consistently. The
  // reducer is seeded with `emptyWorld()` and the snapshot arrives from a
  // mount effect, so the first client render — the only one hydration compares
  // — reads the same world the static export did. A guard here would be
  // ceremony, and a guard on two of the three reads would be worse: it reads
  // as though the third were an oversight.
  const queued = world.syncQueue.length;
  const promotions = runningPromotions(world);
  const stopped = DAEMON_NAMES.filter(name => world.clock.paused[name]);

  const parts: string[] = [];

  for (const promotion of promotions) {
    parts.push(`${promotion.fieldName} building ${promotion.cursor}/${promotion.total}`);
  }

  if (queued > 0) {
    parts.push(`${queued} ${queued === 1 ? 'row' : 'rows'} queued for a slot`);
  }

  return (
    <div className={styles.now}>
      <span className={styles.label}>now</span>

      {parts.length === 0 ? (
        // Reads as deliberately idle rather than broken — the same discipline
        // the empty tables and the empty log follow.
        <span className={styles.idle}>nothing in flight</span>
      ) : (
        <span className={styles.parts}>{parts.join(' · ')}</span>
      )}

      {stopped.length > 0 && (
        <span className={`tag tag-pending ${styles.stopped}`}>
          <span className="dot" />
          {stopped.length === DAEMON_NAMES.length
            ? 'all daemons stopped'
            : `${stopped.join(', ')} stopped`}
        </span>
      )}
    </div>
  );
}
