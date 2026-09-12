'use client';

import type { ReactNode } from 'react';
import { useTranslations } from '@/lib/i18n';
import type { DaemonName } from '@/lib/sim/clock';
import { usePlayground } from './PlaygroundContext';
import styles from './DaemonCard.module.css';

type Props = {
  name: DaemonName;
  /** `singleton` or `multi-worker` — a real operational property, not a label. */
  kind: 'singleton' | 'multi-worker';
  role: string;
  /** The card body: whatever shared state this daemon reads or writes. */
  children: ReactNode;
};

/**
 * One daemon, with its poll period, its pause toggle, and what it last did.
 *
 * The pause toggle is the reason this page exists. Stopping one daemon and
 * leaving the others running is not a debugging affordance — it is how a
 * visitor causes the promotion window rather than reading about it, and it is
 * the only way to see that the four of them are genuinely independent
 * processes rather than four stages of one pipeline.
 *
 * **A quiet card is not a broken card.** The Liberator emits nothing on an idle
 * tick and the Chronicler emits nothing at all yet, which is exactly what the
 * real daemons do with no work; the card says which of the two it is instead of
 * inventing a heartbeat.
 */
export default function DaemonCard({ name, kind, role, children }: Props) {
  const { world, dispatch } = usePlayground();
  const { clock } = world;
  const t = useTranslations('playground');

  const paused = clock.paused[name];
  const period = clock.periods[name];
  const activity = world.daemonActivity[name];

  // The pulse fires on the tick the daemon actually ran, not on every tick it
  // was due — a daemon that found nothing to do did not run in any sense a
  // visitor cares about.
  const live = activity !== undefined && activity.tick === clock.tick;

  // `advance()` increments first and then tests `tick % period === 0`, so the
  // next run is at the next multiple *strictly after* the current tick. The
  // `|| period` idiom that looks right here reads 0 at tick 0 and at every
  // multiple, which is precisely when the answer should be a full period.
  const ticksUntil = paused ? null : period - (clock.tick % period);

  return (
    <div className={`panel ${styles.card} ${live ? styles.live : ''} ${paused ? styles.paused : ''}`}>
      <div className="panel-head">
        <span className={styles.name}>
          <span className={`${styles.pulse} ${live ? styles.pulseOn : ''}`} aria-hidden="true" />
          {name}
        </span>
        <span className="tag">{kind}</span>
      </div>

      <div className={styles.body}>
        <p className={styles.role}>{role}</p>

        <div className={styles.controls}>
          <button
            type="button"
            className="btn"
            aria-pressed={paused}
            onClick={() => dispatch({ type: 'daemon/togglePaused', daemon: name })}
          >
            {paused ? t('daemonRoom.startButton') : t('daemonRoom.stopButton')}
          </button>
          <span className={styles.period}>
            {t('daemonRoom.pollsEvery', { period })}
            {paused ? (
              <em className={styles.stopped}>{t('daemonRoom.stoppedNotPolling')}</em>
            ) : (
              // Not paused, so `ticksUntil` is `period - (tick % period)` — a
              // number. The type stays nullable because it is computed once
              // for both branches above.
              <em>{t('daemonRoom.nextIn', { ticks: ticksUntil as number })}</em>
            )}
          </span>
        </div>

        <div className={styles.slot}>{children}</div>

        <p className={styles.last}>
          {activity === undefined ? (
            <span className={styles.dim}>{t('daemonRoom.notPolledYet')}</span>
          ) : (
            <>
              <span className={styles.dim}>t{activity.tick}</span>{' '}
              {t(activity.action.key, activity.action.params)}
            </>
          )}
        </p>
      </div>
    </div>
  );
}
