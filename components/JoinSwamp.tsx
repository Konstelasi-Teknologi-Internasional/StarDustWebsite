'use client';

import { useEffect, useState } from 'react';
import AnimatedNumber from './AnimatedNumber';
import { useInView } from '@/lib/useInView';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { useTicker } from '@/lib/useTicker';
import styles from './JoinSwamp.module.css';

const ENTRIES = 100_000;
const MAX_CONDITIONS = 6;

/**
 * An illustrative cost model, and labelled as one on the page.
 *
 * EAV needs one self-join per filtered attribute, and the optimiser has to
 * carry an intermediate result between them — so the work grows with the
 * number of conditions even though the answer gets *smaller*. StarDust joins
 * one extension page regardless, and each extra condition is another
 * predicate on the same indexed row, so more conditions only narrows.
 */
function eavRowsExamined(n: number): number {
  return Math.round(ENTRIES * 0.8 * Math.pow(3.1, n - 1));
}

function starDustRowsExamined(n: number): number {
  return Math.max(140, Math.round(4200 / Math.pow(1.9, n - 1)));
}

function eavSql(n: number): string {
  const joins = Array.from({ length: n }, (_, i) => {
    const a = `a${i + 1}`;
    return `  JOIN entry_attribute ${a}\n    ON ${a}.entry_id = e.id AND ${a}.attr = 'f${i + 1}'`;
  }).join('\n');

  const preds = Array.from({ length: n }, (_, i) => `a${i + 1}.value = ?`).join('\n   AND ');

  return `SELECT e.id\n  FROM entry e\n${joins}\n WHERE e.tenant_id = ?\n   AND ${preds}`;
}

/**
 * Query one of the two-query bounded read. Every leaf that resolves to the
 * same page shares one alias, which is why the join count does not move with
 * n — the compiler allocates `p0`, `p1`, … per *page*, not per predicate.
 */
function starDustSql(n: number): string {
  const preds = Array.from({ length: n }, (_, i) => `p0.i_str_0${i + 1} = ?`).join('\n   AND ');
  return (
    `SELECT entry_data.id FROM entry_data\n` +
    `INNER JOIN entry_slots_page_1 p0\n` +
    `        ON p0.entry_id  = entry_data.id\n` +
    `       AND p0.tenant_id = entry_data.tenant_id\n` +
    ` WHERE entry_data.tenant_id = ?\n` +
    `   AND ${preds}\n` +
    ` ORDER BY entry_data.id LIMIT ?\n\n` +
    `-- then one more query to materialise those ids`
  );
}

function Bar({ value, max, tone }: { value: number; max: number; tone: 'bad' | 'good' }) {
  // Log scale: the two sides differ by orders of magnitude at n = 6, and a
  // linear bar would render the fast one as a single invisible pixel.
  const pct = Math.max(2, (Math.log10(value) / Math.log10(max)) * 100);
  return (
    <div className={styles.barTrack}>
      <div
        className={`${styles.barFill} ${tone === 'bad' ? styles.barBad : styles.barGood}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default function JoinSwamp() {
  const [ref, visible] = useInView<HTMLDivElement>();
  const [n, setN] = useState(1);
  const [autoplay, setAutoplay] = useState(true);
  const reduced = useReducedMotion();

  // Walk 1 → 6 once on first view, then stop and hand control over. The
  // growth is the whole point, and a static slider hides it.
  useTicker(visible && autoplay && !reduced, 1100, () => {
    setN(current => {
      if (current >= MAX_CONDITIONS) {
        setAutoplay(false);
        return current;
      }
      return current + 1;
    });
  });

  useEffect(() => {
    if (reduced) setAutoplay(false);
  }, [reduced]);

  const eav = eavRowsExamined(n);
  const sd = starDustRowsExamined(n);
  const scale = eavRowsExamined(MAX_CONDITIONS);
  const factor = Math.round(eav / sd);

  return (
    <div className={styles.demo} ref={ref}>
      <div className={styles.control}>
        <label className={styles.sliderLabel} htmlFor="conditions">
          filter conditions
          <strong>{n}</strong>
        </label>
        <input
          id="conditions"
          type="range"
          min={1}
          max={MAX_CONDITIONS}
          value={n}
          className={styles.slider}
          onChange={e => {
            setAutoplay(false);
            setN(Number(e.target.value));
          }}
        />
        <span className={styles.corpus}>
          over {ENTRIES.toLocaleString('en-US')} entries
        </span>
      </div>

      <div className={styles.grid}>
        <div className={`panel ${styles.side} ${styles.bad}`}>
          <div className="panel-head">
            <span>EAV — one self-join per condition</span>
            <span className="tag tag-error">{n} join{n > 1 ? 's' : ''}</span>
          </div>

          <div className={styles.sideBody}>
            <pre className={styles.sql}>{eavSql(n)}</pre>

            <div className={styles.metrics}>
              <div className={styles.metric}>
                <span className={styles.metricLabel}>rows examined · log scale</span>
                <span className={`${styles.metricValue} ${styles.valueBad}`}>
                  <AnimatedNumber value={eav} />
                </span>
              </div>
              <Bar value={eav} max={scale} tone="bad" />
              <p className={styles.metricNote}>
                Each condition adds a join, and the intermediate result has to be
                carried through all of them — so asking a <em>narrower</em> question
                costs strictly more.
              </p>
            </div>
          </div>
        </div>

        <div className={`panel ${styles.side} ${styles.good}`}>
          <div className="panel-head">
            <span>StarDust — one page join, always</span>
            <span className="tag tag-indexed">1 join · 2 queries</span>
          </div>

          <div className={styles.sideBody}>
            <pre className={styles.sql}>{starDustSql(n)}</pre>

            <div className={styles.metrics}>
              <div className={styles.metric}>
                <span className={styles.metricLabel}>rows examined · log scale</span>
                <span className={`${styles.metricValue} ${styles.valueGood}`}>
                  <AnimatedNumber value={sd} />
                </span>
              </div>
              <Bar value={sd} max={scale} tone="good" />
              <p className={styles.metricNote}>
                Every condition is another predicate on the same indexed row of the
                same extension page. Narrower question, less work — the way an index
                is supposed to behave.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.summary}>
        <div className={styles.factor}>
          <strong>
            ~<AnimatedNumber value={factor} />×
          </strong>
          <span>more rows touched by EAV at {n} condition{n > 1 ? 's' : ''}</span>
        </div>
        <p className={styles.disclaimer}>
          An illustrative cost model of join fan-out — not a benchmark. The shape is
          what matters: EAV grows with the number of conditions, StarDust does not.
          Measure your own workload before quoting a number.
        </p>
      </div>
    </div>
  );
}
