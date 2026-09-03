'use client';

import { useState } from 'react';
import { SECTION_LABELS } from '@/lib/sim/notify';
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

  if (cards.length === 0 && history.length === 0) return null;

  return (
    <div className={styles.dock}>
      {open && (
        <div className={`panel ${styles.drawer}`}>
          <div className="panel-head">
            <span>what has happened</span>
            <span className="tag tag-json">last {history.length}</span>
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
                <span className={styles.pastWhere}>{SECTION_LABELS[card.section]}</span>
              </a>
            ))}
          </div>
          <p className={styles.drawerFoot}>
            The complete stream, unabridged, is the event log in the daemon section.
          </p>
        </div>
      )}

      <div className={styles.stack} role="status" aria-label="What just changed">
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
                aria-label={`Dismiss: ${card.headline}`}
              >
                ×
              </button>
            </div>
            <p className={styles.detail}>{card.detail}</p>
            {/* The affordance the whole feature exists for: the thing that
                changed is somewhere else on a very long page. */}
            <a href={`#${card.section}`} className={styles.jump}>
              go to {SECTION_LABELS[card.section]} →
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
        {open ? 'hide' : `what has happened · ${history.length}`}
      </button>
    </div>
  );
}
