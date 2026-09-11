'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeBlock from '@/components/CodeBlock';
import { useLocale, useTranslations } from '@/lib/i18n';
import { clearFlights, fly, type FlyOptions } from '@/lib/fly';
import { defaultPageColumns } from '@/lib/sim/capacity';
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
import { fieldIndexState } from '@/lib/sim/world';
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
  const t = useTranslations('playground');

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
          label: t('entryWriter.fields'),
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
    // `t` is deliberately not a dependency — see `useNarration`'s comment on
    // the same point: `useTranslations` hands back a new function every
    // render, and the locale it is bound to never changes for the life of
    // this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          label: t('entryWriter.status.queued', { name }),
          tone: 'pending',
          duration: 720,
          stopAt: 0.45,
        } satisfies FlyOptions,
      })),
      ...outcome.jsonOnly.map(name => ({
        name,
        target: NODE.wall as string,
        opts: {
          label: t('entryWriter.flightJsonOnly', { name }),
          tone: 'json',
          duration: 720,
          stopAt: 0.45,
        } satisfies FlyOptions,
      })),
      ...outcome.unknownKeys.map(name => ({
        name,
        target: NODE.wall as string,
        opts: {
          label: t('entryWriter.flightUnknownKey', { name }),
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
    <section className={styles.section} id="write" aria-labelledby="write-title" tabIndex={-1}>
      <p className="eyebrow">{t('entryWriter.eyebrow')}</p>
      <h2 id="write-title" className={styles.title}>
        {t('entryWriter.title')}
      </h2>
      <p className="section-lede">
        {t('entryWriter.lede1')}
        <code>entry_data</code>
        {t('entryWriter.lede2')}
      </p>

      {models.length === 0 ? (
        <div className={`panel ${styles.blocked}`}>
          <div className="panel-head">
            <span>{t('entryWriter.blockedTitle')}</span>
            <span className="tag tag-json">{t('entryWriter.blockedTag')}</span>
          </div>
          <p>
            {t('entryWriter.blockedBody1')}
            <a href="#define">{t('entryWriter.blockedLink')}</a>
            {t('entryWriter.blockedBody2')}
          </p>
        </div>
      ) : (
        <>
          <div className={styles.grid}>
            {/* ---- the payload ---- */}
            <div className={`panel ${styles.formPanel}`}>
              <div className="panel-head">
                <span>{t('entryWriter.payloadTitle')}</span>
                <span className={styles.headRight}>
                  <label className={styles.modelLabel} htmlFor="write-model">
                    {t('entryWriter.modelSelectLabel')}
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
                      {t('entryWriter.pickOne')}
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
                    {t('entryWriter.hintPickModel1')}
                    <code>stardust_fields</code>
                    {t('entryWriter.hintPickModel2')}
                  </p>
                ) : rows.length === 0 ? (
                  <p className={styles.hint}>{t('entryWriter.hintNoFields')}</p>
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
                    {t('entryWriter.addKeyButton')}
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
                  {t('entryWriter.clearButton')}
                </button>
              </div>

              {/* Simulates the message a real EntryWriteException would carry —
                  left untranslated in both locales on the same fidelity rule
                  as `ModelBuilder`'s `draft.error`. */}
              {draft.error !== null && (
                <p className={styles.error} role="status">
                  {draft.error}
                </p>
              )}
            </div>

            {/* ---- what the gestures are ---- */}
            <div className={styles.side}>
              <CodeBlock code={snippet} lang="php" title={t('entryWriter.sideCodeTitle')} copyable />
              <aside className={styles.aside}>
                <h3>{t('entryWriter.asideHeading')}</h3>
                <p>
                  {t('entryWriter.asideBody1P1')}
                  <em>{t('entryWriter.asideBody1Would')}</em>
                  {t('entryWriter.asideBody1P2')}
                  <code>entry_data.fields</code>
                  {t('entryWriter.asideBody1P3')}
                  <code>int</code>
                  {t('entryWriter.asideBody1P4')}
                  <code>&quot;42&quot;</code>
                  {t('entryWriter.asideBody1P5')}
                </p>
                <p>{t('entryWriter.asideBody2')}</p>
              </aside>
            </div>
          </div>

          {/* ---- the verdict ---- */}
          <WriteVerdict outcome={lastWrite} queueDepth={world.syncQueue.length} />

          {/* ---- entry_data ---- */}
          <div className={styles.mirror}>
            <TableView<SimEntry>
              name="entry_data"
              note={t('entryWriter.mirrorNote')}
              about={
                <>
                  {t('entryWriter.mirrorAbout1')}
                  <code>fields</code>
                  {t('entryWriter.mirrorAbout2')}
                  <strong>name</strong>
                  {t('entryWriter.mirrorAbout3')}
                  <strong>{t('entryWriter.mirrorAboutDeleteSoft')}</strong>
                  {t('entryWriter.mirrorAbout4')}
                  <code>deleted_at</code>
                  {t('entryWriter.mirrorAbout5')}
                  <code>false</code>
                  {t('entryWriter.mirrorAbout6')}
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
              empty={t('entryWriter.mirrorEmpty')}
            />

            {/* A no-op delete has no visual event of its own — the row does not
                change and nothing is logged — so the one place it can be
                observed is here. Polite rather than assertive: it is the result
                of something the visitor just did, not an interruption. */}
            <p className={styles.deleteNote} role="status" aria-live="polite">
              {draft.lastDelete === null
                ? ''
                : t(draft.lastDelete.deleted ? 'entryWriter.deleteTrue' : 'entryWriter.deleteFalse', {
                    tenantId: world.tenantId,
                    entryId: draft.lastDelete.entryId,
                  })}
            </p>

            {/* The wall. Not a divider with a caption: the thing the ghosts
                stop at is the panel below saying the table does not exist. */}
            <div className={styles.wall} ref={setNode(NODE.wall)} aria-hidden="true">
              <span className={styles.wallLine} />
              <span className={styles.wallLabel}>{t('entryWriter.wallLabel')}</span>
              <span className={styles.wallLine} />
            </div>

            <div className={`panel ${styles.absent}`}>
              <div className="panel-head">
                <span>entry_slots_page_N</span>
                <span className="tag tag-json">{t('entryWriter.absentTag')}</span>
              </div>
              <p>
                {t('entryWriter.absentBody1a')}
                <em>{t('entryWriter.absentBody1To')}</em>
                {t('entryWriter.absentBody1b')}
                <code>is_filterable = 1</code>
                {t('entryWriter.absentBody1c')}
                <code>stardust_sync_queue</code>
                {t('entryWriter.absentBody1d')}
              </p>
              <p className={styles.absentNote}>{t('entryWriter.absentNote')}</p>
              <div className={styles.absentDdl}>
                <CodeBlock
                  code={pageDdl(1, defaultPageColumns())}
                  lang="sql"
                  title={t('entryWriter.ddlTitle')}
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
          <div className={styles.log}>
            <EventLog
              events={world.events}
              sources={['api', 'bulk_api']}
              title={t('entryWriter.logTitle')}
              note="source=api · source=bulk_api"
              empty={t('entryWriter.logEmpty')}
            />
          </div>
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
  const t = useTranslations('playground');

  if (outcome === null) {
    return (
      <div className={`panel ${styles.verdict} ${styles.verdictIdle}`}>
        <p>
          {t('entryWriter.verdictIdlePrefix')}
          <code>write()</code>
          {t('entryWriter.verdictIdleSuffix')}
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
              {t('entryWriter.enqueuedTag')}
            </span>
          ) : (
            <span className="tag tag-json">
              <span className="dot" />
              {t('entryWriter.nothingQueuedTag')}
            </span>
          )}
        </span>
      </div>

      <div className={styles.verdictBody}>
        <Bucket
          label={t('entryWriter.status.mirrored')}
          tone="indexed"
          names={outcome.slotsWritten.map(s => `${s.fieldName} → ${s.slotColumn}`)}
          empty={t('entryWriter.bucketEmptyNoPage')}
        />
        <Bucket
          label={t('entryWriter.status.waiting')}
          tone="pending"
          names={outcome.awaitingSlot}
          empty={t('entryWriter.bucketEmptyNoFilterable')}
          note={
            outcome.awaitingSlot.length > 0
              ? t('entryWriter.bucketNoteQueue', { depth: queueDepth })
              : undefined
          }
        />
        <Bucket
          label={t('entryWriter.status.jsonOnly')}
          tone="json"
          names={outcome.jsonOnly}
          empty={t('entryWriter.bucketEmptyGeneric')}
          note={outcome.jsonOnly.length > 0 ? t('entryWriter.bucketNoteJsonOnly') : undefined}
        />
        <Bucket
          label={t('entryWriter.status.unknown')}
          tone="json"
          names={outcome.unknownKeys}
          empty={t('entryWriter.bucketEmptyGeneric')}
          note={outcome.unknownKeys.length > 0 ? t('entryWriter.bucketNoteUnknown') : undefined}
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
  const t = useTranslations('playground');
  const locale = useLocale();
  const chunks = Math.ceil(SEED_COUNT / DEFAULT_CHUNK_SIZE);

  return (
    <div className={`panel ${styles.seed}`}>
      <div className="panel-head">
        <span>bulkWrite()</span>
        <span className="tag tag-json">{t('entryWriter.seedTag')}</span>
      </div>

      <div className={styles.seedBody}>
        <div>
          <p>
            {t('entryWriter.seedBody1a', {
              seedCount: SEED_COUNT,
              chunkSize: DEFAULT_CHUNK_SIZE,
              chunks,
              remainder: SEED_COUNT - DEFAULT_CHUNK_SIZE,
            })}
            <em>{t('entryWriter.seedBody1Not')}</em>
            {t('entryWriter.seedBody1b', { chunks, seedCount: SEED_COUNT })}
          </p>
          <p className={styles.seedNote}>
            {t('entryWriter.seedBody2a', {
              threshold: SYNC_THRESHOLD.toLocaleString(locale === 'id' ? 'id-ID' : 'en-US'),
            })}
            <code>submitBulkWrite()</code>
            {t('entryWriter.seedBody2b')}
          </p>
          <button type="button" className="btn" disabled={disabled} onClick={onSeed}>
            {t('entryWriter.seedButton', { count: SEED_COUNT })}
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
