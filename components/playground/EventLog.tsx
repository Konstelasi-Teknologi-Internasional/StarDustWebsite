'use client';

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useTranslations } from '@/lib/i18n';
import type { EventSource, SimEvent } from '@/lib/sim/events';
import { EVENT_LOG_LIMIT } from '@/lib/sim/world';
import styles from './EventLog.module.css';

type Props = {
  events: SimEvent[];
  /**
   * Restrict to these sources. Section C passes the two API sources so its
   * panel is about what *the caller* did; the daemon section passes nothing
   * and gets the interleaved stream, which is its whole point.
   */
  sources?: readonly EventSource[];
  /** Panel-head label. */
  title?: ReactNode;
  /** Right-hand chip in the head. */
  note?: ReactNode;
  /** Lines rendered. Defaults to the world's own retention limit. */
  limit?: number;
  /**
   * Shown instead of lines when there are none. Required, and deliberately so
   * — the same reasoning as `TableView`'s `empty`. This panel is empty for the
   * whole of the walkthrough until the first write, and that has to read as
   * deliberate rather than broken.
   */
  empty: ReactNode;
  /** Log height. The panel does not grow with the stream. */
  height?: string;
};

/**
 * The NDJSON event stream, rendered.
 *
 * Lifted from the landing page's `FieldLifecycle` as a **copy**, on the same
 * rule that produced `TableView` and `DraftFieldRow`: the home page is shipped
 * and working, and coupling four proven demos to a growing simulator trades a
 * stable asset for a convenience.
 *
 * Two shape decisions worth not undoing:
 *
 * - **`seq` and `tick` render outside the braces.** `events.ts` says `seq` is
 *   "not part of the wire shape", and the same is true of the tick — they are
 *   the simulation's bookkeeping, not fields the engine would log. Drawing
 *   them as JSON keys would put two invented keys into a panel whose entire
 *   claim is that these are the engine's lines.
 * - **This is not an `aria-live` region.** A seed emits a burst, and once the
 *   daemons land the stream never stops; announcing every line would make the
 *   page unusable with a screen reader. It is a labelled region instead, and
 *   the single outcome of an action is announced by the control that caused
 *   it.
 */
export default function EventLog({
  events,
  sources,
  title,
  note,
  limit = EVENT_LOG_LIMIT,
  empty,
  height,
}: Props) {
  const logRef = useRef<HTMLDivElement | null>(null);
  const t = useTranslations('playground');

  const lines = useMemo(() => {
    const filtered =
      sources === undefined ? events : events.filter(e => sources.includes(e.source));
    return filtered.slice(-limit);
  }, [events, sources, limit]);

  // Pin to the newest line. Matches the landing page's log, and the smooth
  // scroll it uses is already neutralised by the global reduced-motion rule.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className={`panel ${styles.panel}`}>
      <div className="panel-head">
        <span>{title ?? t('eventLog.title')}</span>
        <span className="tag tag-json">{note ?? t('eventLog.note')}</span>
      </div>

      {lines.length === 0 ? (
        <p className={styles.empty}>{empty}</p>
      ) : (
        <>
        {/* Same rule as `TableView`'s truncation note: a silently shortened
            panel in a section whose whole claim is "these are the engine's
            lines" is worse than a long one. It matters more from the daemon
            stage on — a chunk that null-coerces five hundred rows emits five
            hundred lines, which is a real thing the engine does and which can
            push a whole poll cycle out of the retained window. */}
        {lines.length >= EVENT_LOG_LIMIT && (
          <p className={styles.truncated}>
            {t('eventLog.truncated', { limit: EVENT_LOG_LIMIT })}
          </p>
        )}
        <div
          className={styles.log}
          ref={logRef}
          role="region"
          aria-label={t('eventLog.regionLabel')}
          tabIndex={0}
          style={height === undefined ? undefined : { height }}
        >
          {lines.map(line => (
            <div key={line.seq} className={`${styles.line} ${styles[line.level] ?? ''}`}>
              <span className={styles.gutter}>
                t{line.tick}
                <span className={styles.seq}>#{line.seq}</span>
              </span>
              <span className={styles.body}>
                <span className={styles.brace}>{'{'}</span>
                <span className={styles.key}>&quot;source&quot;</span>
                <span className={styles.brace}>:</span>
                <span className={styles.source}>&quot;{line.source}&quot;</span>
                <span className={styles.brace}>,</span>
                <span className={styles.key}>&quot;event&quot;</span>
                <span className={styles.brace}>:</span>
                <span className={styles.event}>&quot;{line.event}&quot;</span>
                {line.detail !== '' && (
                  <>
                    <span className={styles.brace}>,</span>
                    <span className={styles.detail}>{line.detail}</span>
                  </>
                )}
                <span className={styles.brace}>{'}'}</span>
              </span>
            </div>
          ))}
        </div>
        </>
      )}
    </div>
  );
}
