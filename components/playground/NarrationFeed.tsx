'use client';

import { useRef, useState } from 'react';
import { useTranslations } from '@/lib/i18n';
import { usePublishHeightVar } from '@/lib/usePublishHeightVar';
import type { FeedCard } from './useNarration';
import styles from './NarrationFeed.module.css';

type Props = {
  cards: FeedCard[];
  history: FeedCard[];
  onDismiss: (seq: number) => void;
};

/**
 * The floating consequence feed.
 *
 * Takes cards and a callback — **not** a `SimWorld` and not the playground
 * context. That is ISP and it is the same posture `EventLog` holds: a
 * component that cannot reach the world cannot encode a rule about it, and
 * everything this one knows arrives as a prop.
 *
 * Two things about the way it looks are load-bearing rather than taste:
 *
 * - **It must not read as a log line.** Sentence case, the body typeface, no
 *   braces and no `key=value`. The event log four sections down is the
 *   engine's voice and its whole claim is that those are the engine's own
 *   lines; a card that mimics it will be quoted back as one.
 * - **One live region, wrapping the stack.** `EventLog` is deliberately *not*
 *   `aria-live`, because a seed emits a burst and the daemons never stop.
 *   Announcing every line would make the page unusable with a screen reader.
 *   This is the same stream collapsed to one sentence per thing that happened,
 *   which is exactly the shape that can be announced — and the visitor who
 *   cannot take in four screens at once is who the feature is for. One
 *   `role="status"` on the container, never one per card.
 */
export default function NarrationFeed({ cards, history, onDismiss }: Props) {
  const [open, setOpen] = useState(false);
  const t = useTranslations('playground');

  const dockRef = useRef<HTMLDivElement | null>(null);
  // Called unconditionally, above the empty-state return below: this
  // component occupies the same corner as `TourPanel` and stays mounted
  // while its own dock appears and disappears with `cards`/`history`, so the
  // hook has to run on every render to notice the swing between them.
  usePublishHeightVar(dockRef, '--dock-h');

  if (cards.length === 0 && history.length === 0) return null;

  return (
    <div ref={dockRef} className={styles.dock}>
      {open && (
        <div className={`panel ${styles.drawer}`}>
          <div className="panel-head">
            <span>{t('narrationFeed.history')}</span>
            <span className="tag tag-json">{t('narrationFeed.lastCount', { count: history.length })}</span>
          </div>
          {/* No empty state, unlike `TableView` and `EventLog`. Every card is
              entered into history on arrival — suppressed ones included — so
              history is a superset of `cards`, and the guard above has already
              returned when both are empty. An "it is empty" branch here would
              describe a state that cannot occur. */}
          <div className={styles.drawerBody}>
            {history.map(card => (
              <a key={card.seq} href={`#${card.section}`} className={styles.past}>
                <span className={`${styles.dot} ${styles[card.tone]}`} />
                <span className={styles.pastText}>
                  {card.headline}
                  {card.count > 1 && <em className={styles.count}>×{card.count}</em>}
                </span>
                <span className={styles.pastWhere}>{t(`sections.${card.section}`)}</span>
              </a>
            ))}
          </div>
          <p className={styles.drawerFoot}>{t('narrationFeed.footer')}</p>
        </div>
      )}

      <div className={styles.stack} role="status" aria-label={t('narrationFeed.liveRegionLabel')}>
        {cards.map(card => (
          <div key={card.seq} className={`panel ${styles.card}`}>
            <div className={styles.cardHead}>
              <span className={`${styles.dot} ${styles[card.tone]}`} />
              <strong className={styles.headline}>{card.headline}</strong>
              {card.count > 1 && <em className={styles.count}>×{card.count}</em>}
              <button
                type="button"
                className={styles.close}
                onClick={() => onDismiss(card.seq)}
                aria-label={t('narrationFeed.dismiss', { headline: card.headline })}
              >
                ×
              </button>
            </div>
            <p className={styles.detail}>{card.detail}</p>
            {/* The affordance the whole feature exists for: the thing that
                changed is somewhere else on a very long page. */}
            <a href={`#${card.section}`} className={styles.jump}>
              {t('narrationFeed.goTo', { target: t(`sections.${card.section}`) })}
            </a>
          </div>
        ))}
      </div>

      <button
        type="button"
        className={styles.toggle}
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
      >
        {open ? t('narrationFeed.hide') : t('narrationFeed.toggle', { count: history.length })}
      </button>
    </div>
  );
}
