'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { clearFlights, fly } from '@/lib/fly';
import { useReducedMotion } from '@/lib/useReducedMotion';
import styles from './SlotMirror.module.css';

type FieldType = 'string' | 'int';

type Field = {
  name: string;
  type: FieldType;
  value: string;
  filterable: boolean;
};

const INITIAL: Field[] = [
  { name: 'name', type: 'string', value: 'Acme', filterable: true },
  { name: 'employees', type: 'int', value: '340', filterable: true },
  { name: 'city', type: 'string', value: 'Berlin', filterable: false },
];

/** The slice of a real page we render. A page carries 60 of these. */
const SLOT_COLUMNS = ['i_str_01', 'i_str_02', 'i_int_01', 'i_num_01'] as const;
type SlotColumn = (typeof SLOT_COLUMNS)[number];

const FAMILY: Record<FieldType, SlotColumn[]> = {
  string: ['i_str_01', 'i_str_02'],
  int: ['i_int_01'],
};

type Phase = 'clean' | 'writing' | 'stored';

/**
 * Reservation is first-fit within the field's type family — which is what
 * SlotReserver does, minus the page-affinity packing that only matters once
 * a model outgrows one page.
 */
function assignSlots(fields: Field[]): Map<string, SlotColumn> {
  const taken = new Set<SlotColumn>();
  const out = new Map<string, SlotColumn>();

  for (const f of fields) {
    if (!f.filterable) continue;
    const col = FAMILY[f.type].find(c => !taken.has(c));
    if (col) {
      taken.add(col);
      out.set(f.name, col);
    }
  }
  return out;
}

export default function SlotMirror() {
  const [fields, setFields] = useState<Field[]>(INITIAL);
  const [phase, setPhase] = useState<Phase>('clean');
  const [stored, setStored] = useState<Field[]>([]);
  const [queryField, setQueryField] = useState('employees');

  const reduced = useReducedMotion();
  const layerRef = useRef<HTMLDivElement | null>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const runId = useRef(0);

  const setNode = useCallback((key: string) => (el: HTMLElement | null) => {
    if (el) nodes.current.set(key, el);
    else nodes.current.delete(key);
  }, []);

  const slots = useMemo(() => assignSlots(stored), [stored]);
  const pendingSlots = useMemo(() => assignSlots(fields), [fields]);

  const payloadJson = useMemo(() => {
    const body = fields
      .map(f => `"${f.name}": ${f.type === 'int' ? f.value || '0' : JSON.stringify(f.value)}`)
      .join(', ');
    return `{ ${body} }`;
  }, [fields]);

  const dirty =
    phase === 'stored' &&
    JSON.stringify(stored) !== JSON.stringify(fields);

  const patch = (name: string, next: Partial<Field>) =>
    setFields(list => list.map(f => (f.name === name ? { ...f, ...next } : f)));

  const runWrite = async () => {
    const layer = layerRef.current;
    const id = ++runId.current;

    if (reduced || !layer) {
      setStored(fields.map(f => ({ ...f })));
      setPhase('stored');
      return;
    }

    clearFlights(layer);
    setPhase('writing');

    const src = nodes.current.get('payload');
    const dataRow = nodes.current.get('entry_data_row');

    // Stage one: the whole payload lands in entry_data. This is the system
    // of record and it happens for every field, filterable or not.
    if (src && dataRow) {
      await fly(layer, src, dataRow, { label: 'fields (JSON)', tone: 'accent', duration: 560 });
    }
    if (runId.current !== id) return;

    // flushSync, not a plain setState: stage two measures the JSON field
    // spans that this render creates, and an async commit would leave every
    // ref undefined on the first write.
    flushSync(() => setStored(fields.map(f => ({ ...f }))));

    // Stage two: only the filterable fields are mirrored outward into typed
    // slot columns. Everything else stops here, in JSON.
    const assigned = assignSlots(fields);
    const flights = fields.map((f, i) => {
      const from = nodes.current.get(`data_field_${f.name}`);
      const col = assigned.get(f.name);

      if (!from) return Promise.resolve();

      if (!col) {
        const wall = nodes.current.get('slot_wall');
        if (!wall) return Promise.resolve();
        return fly(layer, from, wall, {
          label: `${f.name} — JSON only`,
          tone: 'danger',
          delay: i * 130,
          duration: 720,
          stopAt: 0.45,
        });
      }

      const to = nodes.current.get(`slot_cell_${col}`);
      if (!to) return Promise.resolve();
      return fly(layer, from, to, {
        label: `${f.value} → ${col}`,
        tone: 'indexed',
        delay: i * 130,
        duration: 700,
      });
    });

    await Promise.all(flights);
    if (runId.current !== id) return;
    setPhase('stored');
  };

  const reset = () => {
    runId.current++;
    if (layerRef.current) clearFlights(layerRef.current);
    setFields(INITIAL.map(f => ({ ...f })));
    setStored([]);
    setPhase('clean');
    setQueryField('employees');
  };

  const target = stored.find(f => f.name === queryField);
  const targetSlot = target ? slots.get(target.name) : undefined;

  return (
    <div className={styles.demo}>
      <div ref={layerRef} className="flyLayer" aria-hidden="true" />

      <div className={styles.grid}>
        {/* ---------- what your application hands the engine ---------- */}
        <div className={`panel ${styles.col}`}>
          <div className="panel-head">
            <span>your write</span>
            <span className="tag tag-accent">EntryPayload</span>
          </div>

          <div className={styles.body}>
            <p className={styles.note}>
              Fields are defined by your tenants at runtime — no migration, no
              <code> ALTER TABLE</code>. Flip a field to filterable and watch where it lands.
            </p>

            <div className={styles.fieldList} ref={setNode('payload')}>
              {fields.map(f => (
                <div key={f.name} className={styles.field}>
                  <div className={styles.fieldTop}>
                    <span className={styles.fieldName}>{f.name}</span>
                    <span className="tag">{f.type}</span>
                  </div>

                  <input
                    className={styles.input}
                    value={f.value}
                    inputMode={f.type === 'int' ? 'numeric' : 'text'}
                    aria-label={`value of ${f.name}`}
                    onChange={e =>
                      patch(f.name, {
                        value:
                          f.type === 'int'
                            ? e.target.value.replace(/[^\d-]/g, '')
                            : e.target.value,
                      })
                    }
                  />

                  <button
                    type="button"
                    role="switch"
                    aria-checked={f.filterable}
                    className={`${styles.toggle} ${f.filterable ? styles.toggleOn : ''}`}
                    onClick={() => patch(f.name, { filterable: !f.filterable })}
                  >
                    <span className={styles.knob} />
                    <span className={styles.toggleLabel}>
                      {f.filterable ? 'filterable' : 'JSON only'}
                    </span>
                  </button>

                  {f.filterable && !pendingSlots.has(f.name) && (
                    <span className="tag tag-pending">no free {f.type} slot — queued for backfill</span>
                  )}
                </div>
              ))}
            </div>

            <div className={styles.actions}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={runWrite}
                disabled={phase === 'writing'}
              >
                {phase === 'writing' ? 'writing…' : 'write()'}
              </button>
              <button type="button" className="btn" onClick={reset} disabled={phase === 'writing'}>
                reset
              </button>
            </div>
          </div>
        </div>

        {/* ---------- what MySQL ends up holding ---------- */}
        <div className={styles.storage}>
          <div className={`panel ${styles.table}`}>
            <div className="panel-head">
              <span>entry_data</span>
              <span className="tag tag-json">system of record · always complete</span>
            </div>

            <div className={styles.tableBody}>
              <div className={styles.tableHead}>
                <span>id</span>
                <span>tenant_id</span>
                <span>model_id</span>
                <span className={styles.grow}>fields (JSON)</span>
              </div>

              <div
                className={`${styles.row} ${phase === 'clean' ? styles.rowEmpty : ''}`}
                ref={setNode('entry_data_row')}
              >
                <span>{phase === 'clean' ? '—' : '7'}</span>
                <span>{phase === 'clean' ? '—' : '1'}</span>
                <span>{phase === 'clean' ? '—' : '42'}</span>
                <span className={`${styles.grow} ${styles.json}`}>
                  {phase === 'clean' ? (
                    <em className={styles.dim}>no row yet</em>
                  ) : (
                    <>
                      {'{ '}
                      {stored.map((f, i) => (
                        <span key={f.name} ref={setNode(`data_field_${f.name}`)} className={styles.jsonPair}>
                          <span className={styles.jsonKey}>&quot;{f.name}&quot;</span>
                          {': '}
                          <span className={styles.jsonVal}>
                            {f.type === 'int' ? f.value || '0' : `"${f.value}"`}
                          </span>
                          {i < stored.length - 1 ? ', ' : ''}
                        </span>
                      ))}
                      {' }'}
                    </>
                  )}
                </span>
              </div>
            </div>
          </div>

          <div className={styles.mirrorArrow} ref={setNode('slot_wall')}>
            <span className={styles.arrowLine} />
            <span className={styles.arrowLabel}>mirror the filterable fields</span>
            <span className={styles.arrowLine} />
          </div>

          <div className={`panel ${styles.table}`}>
            <div className="panel-head">
              <span>entry_slots_page_1</span>
              <span className="tag tag-indexed">1:1 extension page · 60 typed slots</span>
            </div>

            <div className={styles.tableBody}>
              <div className={`${styles.tableHead} ${styles.slotHead}`}>
                <span>entry_id</span>
                {SLOT_COLUMNS.map(c => (
                  <span key={c}>{c}</span>
                ))}
                <span className={styles.dim}>…56 more</span>
              </div>

              <div className={`${styles.row} ${styles.slotRow} ${phase === 'clean' ? styles.rowEmpty : ''}`}>
                <span>{phase === 'clean' ? '—' : '7'}</span>
                {SLOT_COLUMNS.map(col => {
                  const owner = [...slots.entries()].find(([, c]) => c === col)?.[0];
                  const field = stored.find(f => f.name === owner);
                  return (
                    <span
                      key={col}
                      ref={setNode(`slot_cell_${col}`)}
                      className={`${styles.slotCell} ${field ? styles.slotFilled : ''}`}
                    >
                      {field ? (
                        <>
                          <strong>{field.type === 'int' ? field.value || '0' : `"${field.value}"`}</strong>
                          <em>{field.name}</em>
                        </>
                      ) : (
                        <span className={styles.dim}>NULL</span>
                      )}
                    </span>
                  );
                })}
                <span className={styles.dim}>…</span>
              </div>

              <div className={styles.indexNote}>
                <span className="dot" style={{ color: 'var(--indexed)' }} />
                composite index on <code>(tenant_id, i_str_01)</code>, <code>(tenant_id, i_int_01)</code>, …
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ---------- the payoff: what a filter on each field costs ---------- */}
      <div className={`panel ${styles.query}`}>
        <div className="panel-head">
          <span>so what does a filter cost?</span>
          {dirty && <span className="tag tag-pending">payload edited — write() again</span>}
        </div>

        <div className={styles.queryBody}>
          <div className={styles.queryPicker}>
            <span className={styles.queryLabel}>filter on</span>
            {fields.map(f => (
              <button
                key={f.name}
                type="button"
                className={`${styles.chip} ${queryField === f.name ? styles.chipOn : ''}`}
                onClick={() => setQueryField(f.name)}
              >
                {f.name}
              </button>
            ))}
          </div>

          <div className={styles.verdict}>
            {phase !== 'stored' || !target ? (
              <p className={styles.dim}>Run <code>write()</code> to see the query plan.</p>
            ) : targetSlot ? (
              <>
                <div className={styles.verdictHead}>
                  <span className="tag tag-indexed">
                    <span className="dot" />
                    index scan
                  </span>
                  <span className={styles.verdictText}>
                    resolved to <code>{targetSlot}</code> — two bounded queries, no JSON scan
                  </span>
                </div>
                <pre className={styles.sql}>
{`SELECT d.id, d.fields
  FROM entry_data d
  JOIN entry_slots_page_1 p ON p.entry_id = d.id
 WHERE d.tenant_id = 1
   AND p.${targetSlot} ${target.type === 'int' ? '> 100' : "= 'Acme'"}   -- ← index range`}
                </pre>
              </>
            ) : target.filterable ? (
              <>
                <div className={styles.verdictHead}>
                  <span className="tag tag-pending">
                    <span className="dot" />
                    queued
                  </span>
                  <span className={styles.verdictText}>
                    filterable, but no slot was free — the value is safe in JSON and the
                    Reconciler will backfill it. The write never failed.
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className={styles.verdictHead}>
                  <span className="tag tag-error">
                    <span className="dot" />
                    rejected at pre-flight
                  </span>
                  <span className={styles.verdictText}>
                    <code>{target.name}</code> occupies no slot column.
                  </span>
                </div>
                <pre className={styles.sqlError}>
{`FieldNotFilterableException: field "${target.name}" is not filterable

  → still readable — it is in the JSON payload
  → but never silently table-scanned on your behalf`}
                </pre>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
