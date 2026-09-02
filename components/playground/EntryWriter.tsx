'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeBlock from '@/components/CodeBlock';
import { clearFlights, fly, type FlyOptions } from '@/lib/fly';
import { pageDdl, TABLE_DDL } from '@/lib/sim/ddl';
import { bulkWriteSnippet, writeEntrySnippetFull } from '@/lib/sim/php';
import type { SimEntry } from '@/lib/sim/types';
import {
  DEFAULT_CHUNK_SIZE,
  payloadRowsFor,
  SEED_COUNT,
  SYNC_THRESHOLD,
  toPayloadFields,
  type EntryWriteOutcome,
} from '@/lib/sim/write';
import { fieldIndexState, SLOTS_PER_PAGE } from '@/lib/sim/world';
import { useReducedMotion } from '@/lib/useReducedMotion';
import EventLog from './EventLog';
import PayloadFieldRow from './PayloadFieldRow';
import { usePlayground } from './PlaygroundContext';
import TableView, { ROW_CLASS, TABLE_ROW_LIMIT, type Column } from './TableView';
import styles from './EntryWriter.module.css';

/**
 * Flight endpoints, named once.
 *
 * `lastRow` and `lastField` are keyed on *"the row this write landed in"*
 * rather than on an entry id the component predicts. Predicting the id would
 * mean a component doing the auto-increment's job, and it would mean every one
 * of six hundred rows registering per-key spans instead of one.
 */
const NODE = {
  payload: 'payload',
  lastRow: 'entry_data_row_last',
  lastField: (name: string) => `entry_data_field_${name}`,
  wall: 'slot_wall',
  slotCell: (pageId: number, column: string) => `slot_cell_${pageId}_${column}`,
} as const;

type Phase = 'idle' | 'flying' | 'settled';

/**
 * Section C — write entries.
 *
 * The section exists for one guarantee: **a write never fails because indexing
 * is behind.** The payload lands in `entry_data` in full, first, whatever the
 * slot situation is, and a field that cannot be mirrored yet leaves a row in
 * `stardust_sync_queue` rather than an error.
 *
 * At this point in the walkthrough nothing has provisioned a page, so *every*
 * filterable field is in that position and every ghost stops short of the
 * wall. That is not a stage the section is embarrassed about — it is the debt
 * the daemon section exists to drain, and the queue filling up here is what
 * gives the Reconciler something real to do later.
 *
 * ## Why there is no `flushSync` here
 *
 * `SlotMirror` on the landing page needs one, because it animates *first* and
 * commits its local state *between* the two stages — so stage two measures DOM
 * nodes that stage one's render created, and an async commit leaves every ref
 * undefined on the first run. That constraint is real, and it is still real
 * there.
 *
 * This section inverts the order. The write is a `dispatch` into the root
 * reducer, and the choreography runs from an effect keyed on the result — by
 * which point React has already committed the row and every ref is live. There
 * is nothing left to flush, and adding a `flushSync` back would be a
 * synchronous render bought for no reason.
 *
 * What the sync render bought was *legibility*: the row appearing after the
 * ghost lands rather than before it. That comes back through `ROW_CLASS`
 * instead — the landed row renders immediately, so it is measurable, but reads
 * as not-yet-arrived until stage one resolves.
 */
export default function EntryWriter() {
  const { world, dispatch } = usePlayground();
  const reduced = useReducedMotion();
  const draft = world.payloadDraft;

  const [phase, setPhase] = useState<Phase>('idle');

  const layerRef = useRef<HTMLDivElement | null>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const runId = useRef(0);
  const played = useRef<EntryWriteOutcome | null>(null);

  const setNode = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      if (el) nodes.current.set(key, el);
      else nodes.current.delete(key);
    },
    [],
  );

  const models = world.models.filter(m => m.deletedAt === null);
  const model = models.find(m => m.id === draft.modelId);

  // Derived from the registry every render, so a field added in section A
  // after this form was opened is simply here. Storing a snapshot was the
  // earlier shape and it went stale silently, which is the one failure this
  // page cannot afford: every section is supposed to read what the previous
  // one produced.
  const rows = useMemo(() => payloadRowsFor(world, draft), [world, draft]);

  const entryRows = useMemo(
    () => (model === undefined ? [] : world.entries.filter(e => e.modelId === model.id)),
    [world.entries, model],
  );

  const lastWrite = draft.lastWrite;
  const landedEntry = useMemo(
    () =>
      lastWrite === null ? undefined : world.entries.find(e => e.id === lastWrite.entryId),
    [world.entries, lastWrite],
  );

  const snippet = useMemo(
    () => writeEntrySnippetFull(toPayloadFields(rows), world.tenantId, draft.modelId),
    [rows, draft.modelId, world.tenantId],
  );

  /* ---------------- the choreography ---------------- */

  useEffect(() => {
    if (lastWrite === null || played.current === lastWrite) return;
    // Identity, not entry id — an update would reuse the id, and two writes of
    // the same payload are still two events. The reducer hands back a fresh
    // outcome object per write, which is what makes that work.
    played.current = lastWrite;

    const layer = layerRef.current;
    if (reduced || layer === null) {
      setPhase('settled');
      return;
    }

    const id = ++runId.current;
    let cancelled = false;

    void (async () => {
      clearFlights(layer);
      setPhase('flying');

      // Stage one: the whole payload into entry_data. Every key, filterable or
      // not — this is the system of record and it is always complete.
      const src = nodes.current.get(NODE.payload);
      const row = nodes.current.get(NODE.lastRow);
      if (src && row) {
        await fly(layer, src, row, {
          label: 'fields (JSON)',
          tone: 'accent',
          duration: 560,
        });
      }
      if (cancelled || runId.current !== id) return;
      setPhase('settled');

      // Stage two: only what has a live slot is mirrored outward. The bucket
      // each key falls into comes from the core — the component asks, it does
      // not decide.
      const flights = flightsFor(lastWrite).map((flight, i) => {
        const from = nodes.current.get(NODE.lastField(flight.name));
        const to = nodes.current.get(flight.target);
        if (!from || !to) return Promise.resolve();
        return fly(layer, from, to, { ...flight.opts, delay: i * 130 });
      });

      await Promise.all(flights);
    })();

    return () => {
      cancelled = true;
      // Clearing the guard is what makes StrictMode's double-invoke survivable.
      // In development React mounts, runs this effect, tears it down and runs it
      // again — so without this the second pass would see the write as already
      // played, the first pass would have been cancelled mid-flight, and the
      // row would sit dimmed by `landing` forever. Resetting lets the second
      // pass replay from the top; the `runId` bump it performs is what stops
      // the abandoned first run from writing state behind it.
      played.current = null;
      clearFlights(layer);
    };
  }, [lastWrite, reduced]);

  /* ---------------- the payload → flight mapping ---------------- */

  function flightsFor(outcome: EntryWriteOutcome) {
    const value = (name: string) => JSON.stringify(landedEntry?.fields[name] ?? null);

    return [
      ...outcome.slotsWritten.map(slot => ({
        name: slot.fieldName,
        target: NODE.slotCell(slot.pageId, slot.slotColumn),
        opts: {
          label: `${value(slot.fieldName)} → ${slot.slotColumn}`,
          tone: 'indexed',
          duration: 700,
        } satisfies FlyOptions,
      })),
      ...outcome.awaitingSlot.map(name => ({
        name,
        target: NODE.wall as string,
        opts: {
          label: `${name} — queued for backfill`,
          tone: 'pending',
          duration: 720,
          stopAt: 0.45,
        } satisfies FlyOptions,
      })),
      ...outcome.jsonOnly.map(name => ({
        name,
        target: NODE.wall as string,
        opts: {
          label: `${name} — JSON only`,
          tone: 'json',
          duration: 720,
          stopAt: 0.45,
        } satisfies FlyOptions,
      })),
      ...outcome.unknownKeys.map(name => ({
        name,
        target: NODE.wall as string,
        opts: {
          label: `${name} — unknown key, stored verbatim`,
          tone: 'json',
          duration: 720,
          stopAt: 0.45,
        } satisfies FlyOptions,
      })),
    ];
  }

  /* ---------------- entry_data, with flight targets ---------------- */

  const entryColumns: Column<SimEntry>[] = [
    { key: 'id', width: '64px', render: e => e.id },
    { key: 'model_id', width: '78px', render: e => e.modelId },
    { key: 'created_at', width: '160px', render: e => e.createdAt },
    {
      key: 'deleted_at',
      width: '160px',
      render: e =>
        e.deletedAt ?? <span className={styles.null}>NULL</span>,
    },
    {
      key: 'fields',
      width: 'minmax(280px, 1fr)',
      render: e => {
        // Per-key spans only on the row the last write landed in. Everywhere
        // else one blob is enough, and six hundred rows of registered refs is
        // not a thing to do to a browser.
        if (lastWrite === null || e.id !== lastWrite.entryId) {
          return <span className={styles.json}>{JSON.stringify(e.fields)}</span>;
        }
        const keys = Object.keys(e.fields);
        return (
          <span className={styles.json}>
            {'{'}
            {keys.map((key, i) => (
              <span key={key} ref={setNode(NODE.lastField(key))} className={styles.jsonPair}>
                <span className={styles.jsonKey}>&quot;{key}&quot;</span>
                {': '}
                <span className={styles.jsonVal}>{JSON.stringify(e.fields[key])}</span>
                {i < keys.length - 1 ? ', ' : ''}
              </span>
            ))}
            {'}'}
          </span>
        );
      },
    },
    {
      // Not a column of entry_data — the one synthetic column on this page,
      // and it says so rather than sitting under a blank header.
      key: 'row-actions',
      header: <span className={styles.synthetic}>(this page)</span>,
      width: '84px',
      align: 'end',
      render: e => (
        <button
          type="button"
          className={styles.icon}
          aria-label={`delete entry ${e.id}`}
          onClick={() => dispatch({ type: 'entry/delete', entryId: e.id })}
        >
          delete
        </button>
      ),
    },
  ];

  /* ---------------- render ---------------- */

  return (
    <section className={styles.section} id="write" aria-labelledby="write-title">
      <p className="eyebrow">section c</p>
      <h2 id="write-title" className={styles.title}>
        Write entries
      </h2>
      <p className="section-lede">
        The payload lands in <code>entry_data</code> in full, first, whatever the index
        situation is. Mirroring a value out into a typed slot column is a separate step,
        and when it cannot happen the entry is queued rather than refused — which is why
        every ghost below stops short of the wall. Nothing has provisioned a page yet.
      </p>

      {models.length === 0 ? (
        <div className={`panel ${styles.blocked}`}>
          <div className="panel-head">
            <span>no models</span>
            <span className="tag tag-json">nothing to write into</span>
          </div>
          <p>
            An entry belongs to a model, so there is nothing to compose until one exists.
            Define one in <a href="#define">section A</a> and this form builds itself from
            the fields you gave it.
          </p>
        </div>
      ) : (
        <>
          <div className={styles.grid}>
            {/* ---- the payload ---- */}
            <div className={`panel ${styles.formPanel}`}>
              <div className="panel-head">
                <span>payload</span>
                <span className={styles.headRight}>
                  <label className={styles.modelLabel} htmlFor="write-model">
                    model
                  </label>
                  <select
                    id="write-model"
                    className={styles.modelSelect}
                    value={draft.modelId ?? ''}
                    onChange={e =>
                      dispatch({
                        type: 'payload/selectModel',
                        modelId: Number(e.target.value),
                      })
                    }
                  >
                    <option value="" disabled>
                      pick one
                    </option>
                    {models.map(m => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </span>
              </div>

              <div className={styles.formBody} ref={setNode(NODE.payload)}>
                {draft.modelId === null ? (
                  <p className={styles.hint}>
                    Pick a model and its fields appear here, in registry order — which is
                    id order, because <code>stardust_fields</code> has no sort column.
                  </p>
                ) : rows.length === 0 ? (
                  <p className={styles.hint}>
                    This model has no fields. That is legal: every key you add below will
                    be an unknown key, and unknown keys are stored verbatim.
                  </p>
                ) : null}

                {rows.map(field => (
                  <PayloadFieldRow
                    key={field.key}
                    field={field}
                    // Straight from the core. `'none'` for the whole of this
                    // stage, because nothing has reserved a slot yet.
                    indexState={
                      field.fieldId === null ? null : fieldIndexState(world, field.fieldId)
                    }
                    onValue={value =>
                      dispatch({ type: 'payload/setValue', name: field.name, value })
                    }
                    onRename={name =>
                      dispatch({ type: 'payload/renameKey', key: field.key, name })
                    }
                    onRemove={() => dispatch({ type: 'payload/removeKey', key: field.key })}
                  />
                ))}

                {draft.modelId !== null && (
                  <button
                    type="button"
                    className={styles.addKey}
                    onClick={() => dispatch({ type: 'payload/addUnknownKey' })}
                  >
                    + add a key this model does not have
                  </button>
                )}
              </div>

              <div className={styles.formFoot}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={draft.modelId === null}
                  onClick={() => dispatch({ type: 'entry/write' })}
                >
                  write()
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={draft.modelId === null}
                  onClick={() => dispatch({ type: 'payload/reset' })}
                >
                  clear
                </button>
              </div>

              {draft.error !== null && (
                <p className={styles.error} role="status">
                  {draft.error}
                </p>
              )}
            </div>

            {/* ---- what the gestures are ---- */}
            <div className={styles.side}>
              <CodeBlock code={snippet} lang="php" title="the call this is" copyable />
              <aside className={styles.aside}>
                <h3>Coercion touches the slot, not the payload</h3>
                <p>
                  The chip beside a value is a preview of what a slot column{' '}
                  <em>would</em> hold. <code>entry_data.fields</code> stores what you
                  actually sent — so an <code>int</code> field given the text{' '}
                  <code>&quot;42&quot;</code> keeps the string in JSON and would put the
                  integer in the slot. The two are allowed to disagree, and the JSON is
                  the one that is the system of record.
                </p>
                <p>
                  Nothing is coerced yet, because no slot exists to coerce for. The
                  preview is here so the rule is visible before the daemons make it
                  load-bearing.
                </p>
              </aside>
            </div>
          </div>

          {/* ---- the verdict ---- */}
          <WriteVerdict outcome={lastWrite} queueDepth={world.syncQueue.length} />

          {/* ---- entry_data ---- */}
          <div className={styles.mirror}>
            <TableView<SimEntry>
              name="entry_data"
              note="system of record · always complete"
              about={
                <>
                  Every write lands here in full, before anything else is attempted. The{' '}
                  <code>fields</code> JSON is keyed by field <strong>name</strong>, and
                  holds unknown keys and non-filterable fields exactly as they were sent.{' '}
                  <strong>Delete is soft</strong> — it stamps <code>deleted_at</code> and
                  stops, keeping any slot values, because nothing can reach them without
                  joining through a live row. Pressing it twice is not an error: the
                  second call returns <code>false</code> and logs nothing, where an update
                  to the same row would throw.
                </>
              }
              rows={entryRows}
              rowKey={e => e.id}
              columns={entryColumns}
              ddl={TABLE_DDL.entry_data}
              maxRows={TABLE_ROW_LIMIT}
              registerRow={e =>
                lastWrite !== null && e.id === lastWrite.entryId
                  ? setNode(NODE.lastRow)
                  : undefined
              }
              rowClass={e => {
                if (e.deletedAt !== null) return ROW_CLASS.deleted;
                if (phase === 'flying' && lastWrite !== null && e.id === lastWrite.entryId) {
                  return ROW_CLASS.landing;
                }
                return undefined;
              }}
              empty="No entries yet. Compose a payload above and press write() — it will land here whether or not any field is indexed."
            />

            {/* A no-op delete has no visual event of its own — the row does not
                change and nothing is logged — so the one place it can be
                observed is here. Polite rather than assertive: it is the result
                of something the visitor just did, not an interruption. */}
            <p className={styles.deleteNote} role="status" aria-live="polite">
              {draft.lastDelete === null
                ? ''
                : draft.lastDelete.deleted
                  ? `deleteEntry(${world.tenantId}, ${draft.lastDelete.entryId}) returned true — deleted_at is stamped, the slot values are kept, and one entry_deleted line was logged.`
                  : `deleteEntry(${world.tenantId}, ${draft.lastDelete.entryId}) returned false. Nothing transitioned, nothing was logged, and the original timestamp is untouched — a repeat delete has already achieved what you asked for. An update to the same row would have thrown instead.`}
            </p>

            {/* The wall. Not a divider with a caption: the thing the ghosts
                stop at is the panel below saying the table does not exist. */}
            <div className={styles.wall} ref={setNode(NODE.wall)} aria-hidden="true">
              <span className={styles.wallLine} />
              <span className={styles.wallLabel}>mirror the filterable fields</span>
              <span className={styles.wallLine} />
            </div>

            <div className={`panel ${styles.absent}`}>
              <div className="panel-head">
                <span>entry_slots_page_N</span>
                <span className="tag tag-json">not provisioned</span>
              </div>
              <p>
                There is nowhere for a value to be mirrored <em>to</em>. Marking a field
                filterable wrote <code>is_filterable = 1</code> to the registry and
                nothing else — no page, no slot, no index. So every filterable field in
                the payload above lands in <code>stardust_sync_queue</code> instead, the
                write succeeds anyway, and the value is safe in the JSON until something
                catches up.
              </p>
              <p className={styles.absentNote}>
                A page is {SLOTS_PER_PAGE} typed columns and appears when a daemon decides
                capacity is needed. That is the next section&rsquo;s job, and this is the
                debt it will be draining.
              </p>
              <div className={styles.absentDdl}>
                <CodeBlock
                  code={pageDdl(1, [])}
                  lang="sql"
                  title="what a provisioner would run"
                  copyable
                />
              </div>
            </div>
          </div>

          {/* ---- bulk ---- */}
          <SeedPanel
            disabled={draft.modelId === null}
            tenantId={world.tenantId}
            modelId={draft.modelId}
            onSeed={() => dispatch({ type: 'entry/seed' })}
          />

          {/* ---- the log ---- */}
          <EventLog
            events={world.events}
            sources={['api', 'bulk_api']}
            title="what the write path logged"
            note="source=api · source=bulk_api"
            empty="Nothing yet. Defining a model logs a message rather than an event, so this stays empty until the first write."
          />
        </>
      )}

      <div ref={layerRef} className="flyLayer" aria-hidden="true" />
    </section>
  );
}

/* ------------------------------------------------------------------ */

function WriteVerdict({
  outcome,
  queueDepth,
}: {
  outcome: EntryWriteOutcome | null;
  queueDepth: number;
}) {
  if (outcome === null) {
    return (
      <div className={`panel ${styles.verdict} ${styles.verdictIdle}`}>
        <p>
          Run <code>write()</code> to see what the payload split into.
        </p>
      </div>
    );
  }

  return (
    <div className={`panel ${styles.verdict}`}>
      <div className="panel-head">
        <span>EntryWriteResult</span>
        <span className={styles.headRight}>
          <span className="tag tag-json">entry_id = {outcome.entryId}</span>
          {outcome.enqueuedForBackfill ? (
            <span className="tag tag-pending">
              <span className="dot" />
              enqueued for backfill
            </span>
          ) : (
            <span className="tag tag-json">
              <span className="dot" />
              nothing queued
            </span>
          )}
        </span>
      </div>

      <div className={styles.verdictBody}>
        <Bucket
          label="mirrored into a slot"
          tone="indexed"
          names={outcome.slotsWritten.map(s => `${s.fieldName} → ${s.slotColumn}`)}
          empty="None. No page is provisioned, so there is no slot column to mirror into."
        />
        <Bucket
          label="filterable, waiting on a slot"
          tone="pending"
          names={outcome.awaitingSlot}
          empty="None. Nothing in this payload is a filterable field."
          note={
            outcome.awaitingSlot.length > 0
              ? `One row went into stardust_sync_queue for the whole entry — not one per field. The queue is ${queueDepth} deep.`
              : undefined
          }
        />
        <Bucket
          label="JSON only"
          tone="json"
          names={outcome.jsonOnly}
          empty="None."
          note={
            outcome.jsonOnly.length > 0
              ? 'These never queue. Having no slot is their steady state, not a delay — so there is nothing for a daemon to fix.'
              : undefined
          }
        />
        <Bucket
          label="unknown keys"
          tone="json"
          names={outcome.unknownKeys}
          empty="None."
          note={
            outcome.unknownKeys.length > 0
              ? 'Not in stardust_fields for this model, stored verbatim, and readable back exactly as sent.'
              : undefined
          }
        />
      </div>
    </div>
  );
}

function Bucket({
  label,
  tone,
  names,
  empty,
  note,
}: {
  label: string;
  tone: 'indexed' | 'pending' | 'json';
  names: string[];
  empty: string;
  note?: string;
}) {
  return (
    <div className={styles.bucket}>
      <span className={`tag tag-${tone}`}>
        <span className="dot" />
        {label}
      </span>
      {names.length === 0 ? (
        <p className={styles.bucketEmpty}>{empty}</p>
      ) : (
        <ul className={styles.bucketList}>
          {names.map(name => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}
      {note && <p className={styles.bucketNote}>{note}</p>}
    </div>
  );
}

function SeedPanel({
  disabled,
  tenantId,
  modelId,
  onSeed,
}: {
  disabled: boolean;
  tenantId: number;
  modelId: number | null;
  onSeed: () => void;
}) {
  return (
    <div className={`panel ${styles.seed}`}>
      <div className="panel-head">
        <span>bulkWrite()</span>
        <span className="tag tag-json">one transaction per chunk</span>
      </div>

      <div className={styles.seedBody}>
        <div>
          <p>
            {SEED_COUNT} rows in one call. The engine chunks at {DEFAULT_CHUNK_SIZE} and
            opens a transaction per chunk, so this commits{' '}
            {Math.ceil(SEED_COUNT / DEFAULT_CHUNK_SIZE)} of them —{' '}
            {DEFAULT_CHUNK_SIZE}, then {SEED_COUNT - DEFAULT_CHUNK_SIZE} — and logs one
            line each. It does <em>not</em> log per entry: the bulk path reports at chunk
            level, which is why the stream below gains{' '}
            {Math.ceil(SEED_COUNT / DEFAULT_CHUNK_SIZE)} lines rather than {SEED_COUNT}.
          </p>
          <p className={styles.seedNote}>
            Above {SYNC_THRESHOLD.toLocaleString('en-US')} entities the synchronous call
            is refused outright and you use <code>submitBulkWrite()</code>, which queues a
            job instead. Every number on this page is a real array length in the simulated
            tables — nothing here is scaled or estimated.
          </p>
          <button type="button" className="btn" disabled={disabled} onClick={onSeed}>
            seed {SEED_COUNT} rows
          </button>
        </div>

        <CodeBlock
          code={bulkWriteSnippet(SEED_COUNT, tenantId, modelId)}
          lang="php"
          copyable
        />
      </div>
    </div>
  );
}
