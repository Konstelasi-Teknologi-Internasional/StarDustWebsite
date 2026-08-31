'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInView } from '@/lib/useInView';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { useTicker } from '@/lib/useTicker';
import styles from './FieldLifecycle.module.css';

const TOTAL_ROWS = 4000;
const CHUNK = 200;

type Act = 0 | 1 | 2 | 3;

const ACTS: { title: string; actor: string; blurb: string }[] = [
  {
    title: 'promoteFieldToFilterable() returns',
    actor: 'your request',
    blurb:
      'The call recorded an intention and came back immediately. Nothing has been indexed. This is the state people file bugs about.',
  },
  {
    title: 'the Watcher provisions capacity',
    actor: 'Watcher · singleton',
    blurb:
      'A page with a free int slot did not exist, so one is provisioned and indexed, and the slot is reserved for the field — as backfilling, not ready.',
  },
  {
    title: 'the Reconciler copies the values',
    actor: 'Reconciler · multi-worker',
    blurb:
      'Every existing entry has to have its value copied out of JSON and into the slot column, in chunks, with a checkpoint after each one.',
  },
  {
    title: 'the slot flips to ready',
    actor: 'Reconciler · final chunk',
    blurb:
      'The last chunk promotes the slot and bumps the schema version. The identical read() call that was throwing a minute ago now returns rows.',
  },
];

type LogLine = { id: number; event: string; detail: string };

let lineId = 0;
const line = (event: string, detail: string): LogLine => ({ id: lineId++, event, detail });

export default function FieldLifecycle() {
  const [ref, visible] = useInView<HTMLDivElement>();
  const reduced = useReducedMotion();

  const [act, setAct] = useState<Act>(0);
  const [cursor, setCursor] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const [running, setRunning] = useState(false);
  const started = useRef(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  const push = useCallback((...lines: LogLine[]) => {
    setLog(prev => [...prev, ...lines].slice(-40));
  }, []);

  const goto = useCallback(
    (next: Act) => {
      setAct(next);
      if (next === 0) {
        setCursor(0);
        setLog([line('retype_started', 'field_id=17 target=int filterable=true')]);
      } else if (next === 1) {
        setCursor(0);
        push(
          line('poll_started', 'daemon=watcher'),
          line('provision_started', 'reason=unmapped_filterable_field'),
          line('page_provisioned', 'page=2 indexed_slots=i_int_01,i_int_02'),
          line('slot_reserved', 'field_id=17 slot=i_int_01 status=backfilling'),
        );
      } else if (next === 2) {
        push(line('chunk_claimed', `job=retype_field_17 cursor=0 chunk=${CHUNK}`));
      } else if (next === 3) {
        setCursor(TOTAL_ROWS);
        push(
          line('promote_to_ready', 'field_id=17 slot=i_int_01 status=ready'),
          line('chunk_complete', `job=retype_field_17 rows=${TOTAL_ROWS}`),
        );
      }
    },
    [push],
  );

  const start = useCallback(() => {
    started.current = true;
    setRunning(true);
    goto(0);
  }, [goto]);

  // Autoplay once, on first sight. Reduced motion gets the finished state
  // rather than a stuttering one — the end state is the actual lesson.
  useEffect(() => {
    if (!visible || started.current) return;
    started.current = true;
    if (reduced) {
      setLog([line('promote_to_ready', 'field_id=17 slot=i_int_01 status=ready')]);
      setAct(3);
      setCursor(TOTAL_ROWS);
      return;
    }
    const t = setTimeout(start, 400);
    return () => clearTimeout(t);
  }, [visible, reduced, start]);

  // Act 1 and 2 are held long enough to read; act 3 is paced by the chunks.
  useEffect(() => {
    if (!running || reduced) return;
    if (act === 0) {
      const t = setTimeout(() => goto(1), 2800);
      return () => clearTimeout(t);
    }
    if (act === 1) {
      const t = setTimeout(() => goto(2), 2200);
      return () => clearTimeout(t);
    }
    if (act === 3) setRunning(false);
  }, [act, running, reduced, goto]);

  // The updater stays pure — it only advances the cursor. Everything that
  // reacts to the cursor (logging a chunk, promoting the slot) happens in the
  // effect below, so nothing fires twice under StrictMode.
  useTicker(running && act === 2 && !reduced, 150, () => {
    setCursor(prev => Math.min(TOTAL_ROWS, prev + CHUNK));
  });

  useEffect(() => {
    if (act !== 2 || cursor === 0) return;
    if (cursor >= TOTAL_ROWS) goto(3);
    else push(line('chunk_written', `job=retype_field_17 cursor=${cursor} rows=${CHUNK}`));
  }, [cursor, act, goto, push]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const indexed = act === 3;
  const slotStatus = act === 0 ? null : act === 3 ? 'ready' : 'backfilling';
  const pct = Math.round((cursor / TOTAL_ROWS) * 100);

  const readout = useMemo(
    () => [
      { label: 'isFilterable', value: 'true', tone: 'accent' as const, note: 'registry intent — set the moment the call returned' },
      {
        label: 'isIndexed',
        value: indexed ? 'true' : 'false',
        tone: indexed ? ('indexed' as const) : ('pending' as const),
        note: indexed ? 'a filter works right now' : 'no live slot a filter could use yet',
      },
    ],
    [indexed],
  );

  return (
    <div className={styles.demo} ref={ref}>
      <div className={styles.timeline}>
        {ACTS.map((a, i) => (
          <button
            key={a.title}
            type="button"
            className={`${styles.step} ${act === i ? styles.stepOn : ''} ${act > i ? styles.stepDone : ''}`}
            onClick={() => {
              setRunning(false);
              goto(i as Act);
              if (i === 2) setCursor(Math.round(TOTAL_ROWS * 0.4));
            }}
          >
            <span className={styles.stepIndex}>{i + 1}</span>
            <span className={styles.stepText}>
              <strong>{a.title}</strong>
              <em>{a.actor}</em>
            </span>
          </button>
        ))}
      </div>

      <p className={styles.blurb}>{ACTS[act].blurb}</p>

      <div className={styles.grid}>
        <div className={`panel ${styles.state}`}>
          <div className="panel-head">
            <span>describeModel(1, 42) → field &quot;employees&quot;</span>
          </div>

          <div className={styles.stateBody}>
            {readout.map(r => (
              <div key={r.label} className={styles.readRow}>
                <span className={styles.readLabel}>{r.label}</span>
                <span className={`tag tag-${r.tone}`}>
                  <span className="dot" />
                  {r.value}
                </span>
                <span className={styles.readNote}>{r.note}</span>
              </div>
            ))}

            <div className={styles.divider} />

            <div className={styles.readRow}>
              <span className={styles.readLabel}>slot</span>
              {slotStatus ? (
                <span className={`tag ${slotStatus === 'ready' ? 'tag-indexed' : 'tag-pending'}`}>
                  <span className="dot" />
                  i_int_01 · {slotStatus}
                </span>
              ) : (
                <span className="tag tag-error">
                  <span className="dot" />
                  none reserved
                </span>
              )}
              <span className={styles.readNote}>
                {slotStatus === 'ready'
                  ? 'live and queryable'
                  : slotStatus
                    ? 'reserved, but pre-flight still rejects it'
                    : 'the Watcher has not run yet'}
              </span>
            </div>

            <div className={styles.progressBlock}>
              <div className={styles.progressTop}>
                <span className={styles.readLabel}>backfill_checkpoints · retype_field_17</span>
                <span className={styles.cursorValue}>
                  {cursor.toLocaleString('en-US')} / {TOTAL_ROWS.toLocaleString('en-US')}
                </span>
              </div>
              <div className={styles.progressTrack}>
                <div
                  className={`${styles.progressFill} ${indexed ? styles.progressDone : ''}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className={styles.progressNote}>
                every entry&apos;s value copied out of JSON into the slot column, {CHUNK} at a time
              </span>
            </div>
          </div>
        </div>

        <div className={`panel ${styles.logPanel}`}>
          <div className="panel-head">
            <span>daemon event stream · NDJSON</span>
            <span className="tag tag-json">stdout</span>
          </div>
          <div className={styles.log} ref={logRef}>
            {log.map(l => (
              <div key={l.id} className={styles.logLine}>
                <span className={styles.logBrace}>{'{'}</span>
                <span className={styles.logKey}>&quot;event&quot;</span>
                <span className={styles.logBrace}>:</span>
                <span className={styles.logEvent}>&quot;{l.event}&quot;</span>
                <span className={styles.logBrace}>,</span>
                <span className={styles.logDetail}>{l.detail}</span>
                <span className={styles.logBrace}>{'}'}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className={`panel ${styles.callPanel} ${indexed ? styles.callOk : styles.callBad}`}>
        <div className="panel-head">
          <span>the same read() call, throughout</span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              started.current = true;
              start();
            }}
          >
            replay
          </button>
        </div>

        <div className={styles.callBody}>
          <pre className={styles.callCode}>
{`$engine->read(new EntryQuery(
    tenantId: 1, modelId: 42,
    filter: LeafNode::local('employees', 'gt', 100),
));`}
          </pre>

          <div className={styles.callResult}>
            {indexed ? (
              <>
                <span className="tag tag-indexed">
                  <span className="dot" />
                  EntryPage · 128 rows
                </span>
                <p>
                  Nothing about the call changed. The engine caught up underneath it.
                </p>
              </>
            ) : (
              <>
                <span className="tag tag-error">
                  <span className="dot" />
                  FieldNotFilterableException
                </span>
                <p>
                  Rejected at pre-flight rather than silently returning an empty page —
                  so a half-built index can never look like &quot;no matches&quot;.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
