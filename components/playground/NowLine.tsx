'use client';

import { useTranslations } from '@/lib/i18n';
import { DAEMON_NAMES } from '@/lib/sim/clock';
import { runningPurges } from '@/lib/sim/delete';
import { runningRenames } from '@/lib/sim/rename';
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
  const t = useTranslations('playground');

  // No `hydrated` guard on any of these, deliberately and consistently. The
  // reducer is seeded with `emptyWorld()` and the snapshot arrives from a
  // mount effect, so the first client render — the only one hydration compares
  // — reads the same world the static export did. A guard here would be
  // ceremony, and a guard on two of the three reads would be worse: it reads
  // as though the third were an oversight.
  const queued = world.syncQueue.length;
  const stopped = DAEMON_NAMES.filter(name => world.clock.paused[name]);

  const parts: string[] = [];

  // **All four drains, not just the backfill.** This shipped knowing only about
  // promotions, which was complete when it was written and stopped being so the
  // moment section F landed — and the omission would have bitten hardest
  // exactly where this line is most needed, since a rename or a purge runs
  // *further* from the clock bar than a promotion does and announces less on
  // the way. A visitor who stops the Reconciler mid-rename and scrolls away
  // would have had a bar reading "nothing in flight" over a half-migrated
  // world. Anything that later opens a fifth kind of checkpoint belongs here in
  // the same change.
  for (const promotion of runningPromotions(world)) {
    parts.push(
      t('nowLine.building', {
        fieldName: promotion.fieldName,
        cursor: promotion.cursor,
        total: promotion.total,
      }),
    );
  }

  for (const rename of runningRenames(world)) {
    parts.push(
      t('nowLine.rewriting', {
        previousName: rename.previousName,
        currentName: rename.currentName,
        cursor: rename.cursor,
        total: rename.total,
      }),
    );
  }

  for (const purge of runningPurges(world)) {
    parts.push(
      purge.kind === 'field'
        ? t('nowLine.purging', { label: purge.label, cursor: purge.cursor, total: purge.total })
        : // The model purge's denominator counts *down* as the chunks delete
          // what they claim, so a cursor/total pair would read as going
          // backwards. The remaining count is the honest figure.
          t('nowLine.deleting', { label: purge.label, total: purge.total }),
    );
  }

  if (queued > 0) {
    parts.push(t(queued === 1 ? 'nowLine.queuedRow' : 'nowLine.queuedRows', { count: queued }));
  }

  return (
    <div className={styles.now}>
      <span className={styles.label}>{t('nowLine.label')}</span>

      {parts.length === 0 ? (
        // Reads as deliberately idle rather than broken — the same discipline
        // the empty tables and the empty log follow.
        <span className={styles.idle}>{t('nowLine.idle')}</span>
      ) : (
        <span className={styles.parts}>{parts.join(' · ')}</span>
      )}

      {stopped.length > 0 && (
        <span className={`tag tag-pending ${styles.stopped}`}>
          <span className="dot" />
          {stopped.length === DAEMON_NAMES.length
            ? t('nowLine.allStopped')
            : t('nowLine.someStopped', { names: stopped.join(', ') })}
        </span>
      )}
    </div>
  );
}
