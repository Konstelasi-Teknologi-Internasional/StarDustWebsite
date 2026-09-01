'use client';

import { useState } from 'react';
import type {
  SimCheckpoint,
  SimDlqRow,
  SimEntry,
  SimField,
  SimJob,
  SimModel,
  SimPage,
  SimSlot,
  SimSyncRow,
} from '@/lib/sim/types';
import { usePlayground } from './PlaygroundContext';
import TableView, { type Column } from './TableView';
import styles from './WorldInspector.module.css';

type Group = 'registry' | 'data' | 'ops';

const GROUPS: { id: Group; label: string; blurb: string }[] = [
  {
    id: 'registry',
    label: 'registry',
    blurb:
      'Metadata. What models and fields exist, which slot on which page each filterable field holds. Defining a field writes here and nowhere else.',
  },
  {
    id: 'data',
    label: 'data plane',
    blurb:
      'Storage. The complete JSON payload of every entry, plus the extension pages that mirror the filterable fields into typed, indexed columns.',
  },
  {
    id: 'ops',
    label: 'operational',
    blurb:
      'The tables the daemons coordinate through. No broker anywhere — every one of the four reads and writes these and nothing else.',
  },
];

const dash = <span className={styles.null}>NULL</span>;

/**
 * Every table the engine bootstraps, inspectable.
 *
 * At this stage they are all empty, and that is the intended first impression:
 * `bootstrap()` creates the schema and provisions nothing. In particular
 * `stardust_pages` is empty — no page exists until something asks for
 * capacity — which is the fact the rest of the walkthrough builds on.
 */
export default function WorldInspector() {
  const { world } = usePlayground();
  const [group, setGroup] = useState<Group>('registry');

  const active = GROUPS.find(g => g.id === group);

  return (
    <div className={styles.inspector}>
      <div className={styles.tabs} role="tablist" aria-label="table groups">
        {GROUPS.map(g => (
          <button
            key={g.id}
            type="button"
            role="tab"
            aria-selected={group === g.id}
            className={`${styles.tab} ${group === g.id ? styles.tabOn : ''}`}
            onClick={() => setGroup(g.id)}
          >
            {g.label}
          </button>
        ))}
      </div>

      {active && <p className={styles.blurb}>{active.blurb}</p>}

      <div className={styles.tables}>
        {group === 'registry' && (
          <>
            <TableView<SimModel>
              name="stardust_models"
              note="one row per model"
              rows={world.models}
              rowKey={m => m.id}
              columns={MODEL_COLUMNS}
              empty="No models yet. This table is written by createModel()."
            />
            <TableView<SimField>
              name="stardust_fields"
              note="declared_type + is_filterable"
              rows={world.fields}
              rowKey={f => f.id}
              columns={FIELD_COLUMNS}
              empty="No fields yet. is_filterable here is intent only — it does not create a slot."
            />
            <TableView<SimPage>
              name="stardust_pages"
              note="one row per extension table"
              rows={world.pages}
              rowKey={p => p.id}
              columns={PAGE_COLUMNS}
              empty="No pages. bootstrap() provisions none — a page appears when something needs slot capacity, and not before."
            />
            <TableView<SimSlot>
              name="stardust_slot_assignments"
              note="60 rows per page"
              rows={world.slots}
              rowKey={s => s.id}
              columns={SLOT_COLUMNS}
              empty="No slots, because there are no pages to carve them out of."
            />
          </>
        )}

        {group === 'data' && (
          <>
            <TableView<SimEntry>
              name="entry_data"
              note="system of record · always complete"
              rows={world.entries}
              rowKey={e => e.id}
              columns={ENTRY_COLUMNS}
              empty="No entries yet. Every write lands here first, in full, whether or not any field is indexed."
            />
            {world.pages.length === 0 ? (
              <div className={`panel ${styles.absent}`}>
                <div className="panel-head">
                  <span>entry_slots_page_N</span>
                  <span className="tag tag-json">not provisioned</span>
                </div>
                <p>
                  There is no extension page to show. Slot columns are named{' '}
                  <code>i_str_NN</code>, <code>i_int_NN</code>, <code>i_num_NN</code> and{' '}
                  <code>i_dt_NN</code> — 25, 15, 10 and 10 of them respectively, 60 to a
                  page — but the table itself does not exist until a page is provisioned.
                </p>
              </div>
            ) : (
              world.pages.map(page => (
                <TableView<SimEntry>
                  key={page.id}
                  name={page.tableName}
                  note={`${page.indexedColumns.length} indexed of 60`}
                  rows={world.entries}
                  rowKey={e => e.id}
                  columns={pageColumnsFor(page)}
                  empty="No mirrored rows yet."
                />
              ))
            )}
          </>
        )}

        {group === 'ops' && (
          <>
            <div className={`panel ${styles.singleton}`}>
              <div className="panel-head">
                <span>stardust_schema_version</span>
                <span className="tag tag-json">singleton · id = 1</span>
              </div>
              <p>
                version <strong>{world.schemaVersion}</strong> — bumped whenever field
                metadata changes, so a cached schema snapshot can tell in one cheap read
                that it is stale.
              </p>
            </div>
            <TableView<SimSyncRow>
              name="stardust_sync_queue"
              note="backfill debt"
              rows={world.syncQueue}
              rowKey={r => r.id}
              columns={SYNC_COLUMNS}
              empty="Empty. A row lands here when a write could not be mirrored into a slot — the write still succeeds."
            />
            <TableView<SimCheckpoint>
              name="backfill_checkpoints"
              note="resumable cursors"
              rows={world.checkpoints}
              rowKey={c => c.jobName}
              columns={CHECKPOINT_COLUMNS}
              empty="Empty. One row appears per running retype, rename or delete, and is removed when it lands."
            />
            <TableView<SimJob>
              name="stardust_import_jobs / stardust_export_jobs"
              note="async work"
              rows={world.jobs}
              rowKey={j => `${j.kind}-${j.id}`}
              columns={JOB_COLUMNS}
              empty="No jobs submitted."
            />
            <TableView<SimDlqRow>
              name="stardust_reconciler_dlq"
              note="poison pills"
              rows={world.dlq}
              rowKey={d => d.id}
              columns={DLQ_COLUMNS}
              empty="Empty, which is the state you want. Rows here outlive their source entry on purpose."
            />
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- column specs ---------- */

const MODEL_COLUMNS: Column<SimModel>[] = [
  { key: 'id', width: '56px', render: m => m.id },
  { key: 'tenant_id', width: '80px', render: m => m.tenantId },
  { key: 'name', width: 'minmax(120px, 1fr)', render: m => m.name },
  { key: 'created_at', width: '150px', render: m => m.createdAt },
  { key: 'deleted_at', width: '150px', render: m => m.deletedAt ?? dash },
];

const FIELD_COLUMNS: Column<SimField>[] = [
  { key: 'id', width: '56px', render: f => f.id },
  { key: 'model_id', width: '76px', render: f => f.modelId },
  { key: 'name', width: 'minmax(110px, 1fr)', render: f => f.name },
  { key: 'declared_type', width: '104px', render: f => f.declaredType },
  {
    key: 'is_filterable',
    width: '96px',
    render: f => (f.isFilterable ? '1' : '0'),
  },
  { key: 'previous_name', width: '116px', render: f => f.previousName ?? dash },
  { key: 'deleted_at', width: '150px', render: f => f.deletedAt ?? dash },
];

const PAGE_COLUMNS: Column<SimPage>[] = [
  { key: 'id', width: '56px', render: p => p.id },
  { key: 'table_name', width: 'minmax(160px, 1fr)', render: p => p.tableName },
  { key: 'provisioned_by', width: '120px', render: p => p.provisionedBy },
  { key: 'provisioned_at', width: '150px', render: p => p.provisionedAt },
];

const SLOT_COLUMNS: Column<SimSlot>[] = [
  { key: 'id', width: '56px', render: s => s.id },
  { key: 'page_id', width: '70px', render: s => s.pageId },
  { key: 'slot_column', width: '104px', render: s => s.slotColumn },
  { key: 'slot_type', width: '80px', render: s => s.slotType },
  { key: 'field_id', width: '76px', render: s => s.fieldId ?? dash },
  { key: 'status', width: 'minmax(110px, 1fr)', render: s => s.status },
  { key: 'sweep_gap_count', width: '124px', align: 'end', render: s => s.sweepGapCount },
];

const ENTRY_COLUMNS: Column<SimEntry>[] = [
  { key: 'id', width: '56px', render: e => e.id },
  { key: 'tenant_id', width: '80px', render: e => e.tenantId },
  { key: 'model_id', width: '76px', render: e => e.modelId },
  {
    key: 'fields',
    width: 'minmax(220px, 1fr)',
    render: e => <span className={styles.json}>{JSON.stringify(e.fields)}</span>,
  },
  { key: 'deleted_at', width: '140px', render: e => e.deletedAt ?? dash },
];

/**
 * An extension page's columns are the page's own — which is why this is a
 * function of the page rather than a constant. Only some of them are indexed,
 * and that is a property of the page (the engine reads it from
 * `information_schema`), never a column on the assignment row.
 */
function pageColumnsFor(page: SimPage): Column<SimEntry>[] {
  return [
    { key: 'entry_id', width: '80px', render: e => e.id },
    { key: 'tenant_id', width: '80px', render: e => e.tenantId },
    ...page.indexedColumns.map<Column<SimEntry>>(col => ({
      key: col,
      width: 'minmax(96px, 1fr)',
      render: e => {
        const value = e.slots[page.id]?.[col];
        return value === undefined || value === null ? dash : String(value);
      },
    })),
  ];
}

const SYNC_COLUMNS: Column<SimSyncRow>[] = [
  { key: 'id', width: '56px', render: r => r.id },
  { key: 'entry_id', width: '90px', render: r => r.entryId },
  { key: 'created_at', width: 'minmax(150px, 1fr)', render: r => r.createdAt },
];

const CHECKPOINT_COLUMNS: Column<SimCheckpoint>[] = [
  { key: 'job_name', width: 'minmax(160px, 1fr)', render: c => c.jobName },
  { key: 'cursor_id', width: '96px', align: 'end', render: c => c.cursorId },
  { key: 'total', width: '80px', align: 'end', render: c => c.totalRows },
  {
    key: 'source_declared_type',
    width: '160px',
    render: c => c.sourceDeclaredType ?? dash,
  },
];

const JOB_COLUMNS: Column<SimJob>[] = [
  { key: 'id', width: '56px', render: j => j.id },
  { key: 'kind', width: '80px', render: j => j.kind },
  { key: 'status', width: '104px', render: j => j.status },
  { key: 'format', width: '80px', render: j => j.format ?? dash },
  { key: 'rows_written', width: '110px', align: 'end', render: j => j.rowsWritten },
  {
    key: 'artifact_path',
    width: 'minmax(150px, 1fr)',
    render: j => j.artifactPath ?? dash,
  },
];

const DLQ_COLUMNS: Column<SimDlqRow>[] = [
  { key: 'id', width: '56px', render: d => d.id },
  { key: 'entry_id', width: '90px', render: d => d.entryId },
  { key: 'reason', width: 'minmax(180px, 1fr)', render: d => d.reason },
  { key: 'created_at', width: '150px', render: d => d.createdAt },
];
