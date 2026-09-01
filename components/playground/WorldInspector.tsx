'use client';

import { useId, useState } from 'react';
import CodeBlock from '@/components/CodeBlock';
import { pageDdl, TABLE_DDL } from '@/lib/sim/ddl';
import type {
  SimCheckpoint,
  SimDlqRow,
  SimEntry,
  SimExportJob,
  SimField,
  SimImportJob,
  SimModel,
  SimPage,
  SimSlot,
  SimSyncRow,
} from '@/lib/sim/types';
import { SLOTS_PER_PAGE } from '@/lib/sim/world';
import PageTable from './PageTable';
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

/** A singleton table still has a row, so it still renders as one. */
type VersionRow = { version: number; updatedAt: string };

/**
 * Every table the engine bootstraps, inspectable.
 *
 * The column headers are the engine's column names and the `DDL` toggle on
 * each panel is the receipt: same names, same types, same nullability as the
 * schema `bootstrap()` creates. Where the simulation carries something the
 * database does not — a page's indexed-column list, an entry's slot mirror —
 * it is rendered as what it is rather than smuggled in as a column.
 *
 * Most of these tables are empty for most of the walkthrough, and that is the
 * intended first impression rather than a gap: `bootstrap()` creates the schema
 * and provisions nothing. In particular `stardust_pages` is empty — no page
 * exists until something asks for capacity — which is the fact the rest of the
 * walkthrough builds on.
 */
export default function WorldInspector() {
  const { world } = usePlayground();
  const [group, setGroup] = useState<Group>('registry');
  const panelId = useId();

  const active = GROUPS.find(g => g.id === group);

  const versionRows: VersionRow[] = [
    { version: world.schemaVersion, updatedAt: world.schemaVersionUpdatedAt },
  ];

  return (
    <div className={styles.inspector}>
      <div className={styles.tabs} role="tablist" aria-label="table groups">
        {GROUPS.map(g => (
          <button
            key={g.id}
            type="button"
            role="tab"
            id={`${panelId}-tab-${g.id}`}
            aria-selected={group === g.id}
            aria-controls={panelId}
            className={`${styles.tab} ${group === g.id ? styles.tabOn : ''}`}
            onClick={() => setGroup(g.id)}
          >
            {g.label}
          </button>
        ))}
      </div>

      {active && <p className={styles.blurb}>{active.blurb}</p>}

      <div
        className={styles.tables}
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${panelId}-tab-${group}`}
        tabIndex={-1}
      >
        {group === 'registry' && (
          <>
            <TableView<SimModel>
              name="stardust_models"
              note="one row per model"
              about="One row per model, unique per tenant by name. There is no updated_at — which is why renaming a model is a single UPDATE with nothing to wait for, unlike renaming a field."
              rows={world.models}
              rowKey={m => m.id}
              columns={MODEL_COLUMNS}
              ddl={TABLE_DDL.stardust_models}
              empty="No models yet. This table is written by createModel()."
            />
            <TableView<SimField>
              name="stardust_fields"
              note="declared_type + is_filterable"
              about="A field is a row here, not a column anywhere. is_filterable is intent — it says you would like to filter on this field, and creates nothing. previous_name and deleted_at are both drain markers: non-null means a migration is running right now."
              rows={world.fields}
              rowKey={f => f.id}
              columns={FIELD_COLUMNS}
              ddl={TABLE_DDL.stardust_fields}
              empty="No fields yet. is_filterable here is intent only — it does not create a slot."
            />
            <TableView<SimPage>
              name="stardust_pages"
              note="one row per extension table"
              about={
                <>
                  One row per <code>entry_slots_page_N</code> table. Notice what is not
                  here: which of a page&rsquo;s slot columns carry an index. That is
                  never stored — the engine asks{' '}
                  <code>information_schema.STATISTICS</code> when it needs to know.
                </>
              }
              rows={world.pages}
              rowKey={p => p.id}
              columns={PAGE_COLUMNS}
              ddl={TABLE_DDL.stardust_pages}
              empty="No pages. bootstrap() provisions none — a page appears when something needs slot capacity, and not before."
            />
            <TableView<SimSlot>
              name="stardust_slot_assignments"
              note={`${SLOTS_PER_PAGE} rows per page`}
              about="The inventory: one row per slot column per page, seeded free and claimed from there. status is a closed five-state ENUM, and a partial unique index enforces that a field holds at most one live slot — the database refuses the alternative rather than trusting the code."
              rows={world.slots}
              rowKey={s => s.id}
              columns={SLOT_COLUMNS}
              ddl={TABLE_DDL.stardust_slot_assignments}
              empty="No slots, because there are no pages to carve them out of."
            />
          </>
        )}

        {group === 'data' && (
          <>
            <TableView<SimEntry>
              name="entry_data"
              note="system of record · always complete"
              about={
                <>
                  Every write lands here in full, first, whatever the index situation
                  is. The <code>fields</code> JSON is keyed by field <strong>name</strong>{' '}
                  — which is why renaming a field is a rewrite of every row in the model
                  rather than a registry update.
                </>
              }
              rows={world.entries}
              rowKey={e => e.id}
              columns={ENTRY_COLUMNS}
              ddl={TABLE_DDL.entry_data}
              empty="No entries yet. Every write lands here first, in full, whether or not any field is indexed."
            />
            {world.pages.length === 0 ? (
              <div className={`panel ${styles.absent}`}>
                <div className="panel-head">
                  <span>entry_slots_page_N</span>
                  <span className="tag tag-json">not provisioned</span>
                </div>
                <p>
                  There is no extension page to show, and there will not be one until
                  something asks for slot capacity. The DDL below is what a provisioner
                  runs when that happens: 60 columns — <code>i_str_NN</code>,{' '}
                  <code>i_int_NN</code>, <code>i_num_NN</code> and <code>i_dt_NN</code>,
                  25, 15, 10 and 10 of them — and no indexes at all, because which
                  columns get one is decided per page from the fields that need them.
                </p>
                <div className={styles.absentDdl}>
                  {/* Page 1 because that is what the first one will be called,
                      and no filterable slots because nothing has asked for an
                      index yet. */}
                  <CodeBlock
                    code={pageDdl(1, [])}
                    lang="sql"
                    title="what a provisioner would run"
                    copyable
                  />
                </div>
              </div>
            ) : (
              world.pages.map(page => (
                <PageTable key={page.id} page={page} world={world} />
              ))
            )}
          </>
        )}

        {group === 'ops' && (
          <>
            <TableView<VersionRow>
              name="stardust_schema_version"
              note="singleton · id = 1"
              about="One row, forever. Field metadata changes bump the version, so a cached schema snapshot can tell in one cheap read that it is stale instead of re-reading the registry on every request."
              rows={versionRows}
              rowKey={() => 1}
              columns={VERSION_COLUMNS}
              ddl={TABLE_DDL.stardust_schema_version}
              empty="Unreachable — the singleton is seeded at bootstrap."
            />
            <TableView<SimSyncRow>
              name="stardust_sync_queue"
              note="backfill debt"
              about="Deliberately tiny: an id, an entry id, a timestamp. A row lands here when a write could not be mirrored into a slot, and the write still succeeds — indexing being behind is never a reason to refuse data."
              rows={world.syncQueue}
              rowKey={r => r.id}
              columns={SYNC_COLUMNS}
              ddl={TABLE_DDL.stardust_sync_queue}
              empty="Empty. A row lands here when a write could not be mirrored into a slot — the write still succeeds."
            />
            <TableView<SimCheckpoint>
              name="backfill_checkpoints"
              note="resumable cursors"
              about="Where a long migration has got to. job_name says which lifecycle the row belongs to and last_processed_id says how far it drained, so a worker that dies mid-backfill is resumed rather than restarted."
              rows={world.checkpoints}
              rowKey={c => c.id}
              columns={CHECKPOINT_COLUMNS}
              ddl={TABLE_DDL.backfill_checkpoints}
              empty="Empty. One row appears per running retype, rename or delete, and is removed when it lands."
            />
            <TableView<SimImportJob>
              name="stardust_import_jobs"
              note="async bulk ingest"
              about="Submitted work, claimed by whichever worker gets there first. The manifest is written chunk by chunk rather than at the end, because it is also the resume point."
              rows={world.importJobs}
              rowKey={j => j.id}
              columns={IMPORT_JOB_COLUMNS}
              ddl={TABLE_DDL.stardust_import_jobs}
              empty="No import jobs submitted."
            />
            <TableView<SimExportJob>
              name="stardust_export_jobs"
              note="async exports"
              about="A separate table with its own columns and its own auto-increment — import job 1 and export job 1 are different rows in different tables. There is no model_id column: it is stamped into the filter JSON alongside the consumer's own filter tree."
              rows={world.exportJobs}
              rowKey={j => j.id}
              columns={EXPORT_JOB_COLUMNS}
              ddl={TABLE_DDL.stardust_export_jobs}
              empty="No export jobs submitted."
            />
            <TableView<SimDlqRow>
              name="stardust_reconciler_dlq"
              note="poison pills"
              about="Where a row goes when it cannot be processed and retrying will not help. It has no foreign key to entry_data on purpose — one of the reasons is missing_entry_data, which only means anything if the record can outlive what produced it."
              rows={world.dlq}
              rowKey={d => d.id}
              columns={DLQ_COLUMNS}
              ddl={TABLE_DDL.stardust_reconciler_dlq}
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
  { key: 'created_at', width: '150px', render: f => f.createdAt },
  { key: 'updated_at', width: '150px', render: f => f.updatedAt },
  { key: 'previous_name', width: '116px', render: f => f.previousName ?? dash },
  { key: 'deleted_at', width: '150px', render: f => f.deletedAt ?? dash },
];

const PAGE_COLUMNS: Column<SimPage>[] = [
  { key: 'id', width: '56px', render: p => p.id },
  { key: 'table_name', width: 'minmax(160px, 1fr)', render: p => p.tableName },
  { key: 'provisioned_at', width: '150px', render: p => p.provisionedAt },
  { key: 'provisioned_by', width: 'minmax(120px, 1fr)', render: p => p.provisionedBy },
];

const SLOT_COLUMNS: Column<SimSlot>[] = [
  { key: 'id', width: '56px', render: s => s.id },
  { key: 'page_id', width: '70px', render: s => s.pageId },
  { key: 'slot_column', width: '104px', render: s => s.slotColumn },
  { key: 'slot_type', width: '80px', render: s => s.slotType },
  { key: 'field_id', width: '76px', render: s => s.fieldId ?? dash },
  { key: 'status', width: 'minmax(110px, 1fr)', render: s => s.status },
  { key: 'sweep_cursor_id', width: '124px', align: 'end', render: s => s.sweepCursorId ?? dash },
  { key: 'tombstoned_at', width: '150px', render: s => s.tombstonedAt ?? dash },
  { key: 'updated_at', width: '150px', render: s => s.updatedAt },
  { key: 'sweep_gap_count', width: '124px', align: 'end', render: s => s.sweepGapCount },
];

const ENTRY_COLUMNS: Column<SimEntry>[] = [
  { key: 'id', width: '56px', render: e => e.id },
  { key: 'tenant_id', width: '80px', render: e => e.tenantId },
  { key: 'model_id', width: '76px', render: e => e.modelId },
  { key: 'created_at', width: '150px', render: e => e.createdAt },
  { key: 'updated_at', width: '150px', render: e => e.updatedAt },
  { key: 'deleted_at', width: '140px', render: e => e.deletedAt ?? dash },
  {
    key: 'fields',
    width: 'minmax(240px, 1fr)',
    render: e => <span className={styles.json}>{JSON.stringify(e.fields)}</span>,
  },
];

const VERSION_COLUMNS: Column<VersionRow>[] = [
  { key: 'id', width: '56px', render: () => 1 },
  { key: 'version', width: '90px', align: 'end', render: v => v.version },
  { key: 'updated_at', width: 'minmax(150px, 1fr)', render: v => v.updatedAt },
];

const SYNC_COLUMNS: Column<SimSyncRow>[] = [
  { key: 'id', width: '56px', render: r => r.id },
  { key: 'entry_id', width: '90px', render: r => r.entryId },
  { key: 'created_at', width: 'minmax(150px, 1fr)', render: r => r.createdAt },
];

const CHECKPOINT_COLUMNS: Column<SimCheckpoint>[] = [
  { key: 'id', width: '56px', render: c => c.id },
  { key: 'job_name', width: 'minmax(160px, 1fr)', render: c => c.jobName },
  { key: 'last_processed_id', width: '146px', align: 'end', render: c => c.lastProcessedId },
  { key: 'status', width: '96px', render: c => c.status },
  { key: 'started_at', width: '150px', render: c => c.startedAt },
  { key: 'updated_at', width: '150px', render: c => c.updatedAt },
  { key: 'completed_at', width: '150px', render: c => c.completedAt ?? dash },
  { key: 'last_error', width: 'minmax(140px, 1fr)', render: c => c.lastError ?? dash },
  {
    key: 'source_declared_type',
    width: '160px',
    render: c => c.sourceDeclaredType ?? dash,
  },
];

const IMPORT_JOB_COLUMNS: Column<SimImportJob>[] = [
  { key: 'id', width: '56px', render: j => j.id },
  { key: 'tenant_id', width: '80px', render: j => j.tenantId },
  { key: 'status', width: '104px', render: j => j.status },
  { key: 'idempotency_key', width: '140px', render: j => j.idempotencyKey ?? dash },
  { key: 'artifact_path', width: 'minmax(150px, 1fr)', render: j => j.artifactPath },
  { key: 'entry_count', width: '106px', align: 'end', render: j => j.entryCount },
  {
    key: 'manifest',
    width: 'minmax(180px, 1fr)',
    render: j =>
      j.manifest === null ? (
        dash
      ) : (
        <span className={styles.json}>{JSON.stringify(j.manifest)}</span>
      ),
  },
  { key: 'failed_reason', width: '130px', render: j => j.failedReason ?? dash },
  { key: 'worker_identity', width: '140px', render: j => j.workerIdentity ?? dash },
  { key: 'claimed_at', width: '150px', render: j => j.claimedAt ?? dash },
  { key: 'heartbeat_at', width: '150px', render: j => j.heartbeatAt ?? dash },
  { key: 'created_at', width: '150px', render: j => j.createdAt },
  { key: 'completed_at', width: '150px', render: j => j.completedAt ?? dash },
];

const EXPORT_JOB_COLUMNS: Column<SimExportJob>[] = [
  { key: 'id', width: '56px', render: j => j.id },
  { key: 'tenant_id', width: '80px', render: j => j.tenantId },
  { key: 'status', width: '104px', render: j => j.status },
  {
    key: 'filter',
    width: 'minmax(200px, 1fr)',
    render: j => <span className={styles.json}>{JSON.stringify(j.filter)}</span>,
  },
  { key: 'format', width: '78px', render: j => j.format },
  { key: 'last_cursor', width: '110px', align: 'end', render: j => j.lastCursor ?? dash },
  { key: 'artifact_path', width: 'minmax(150px, 1fr)', render: j => j.artifactPath ?? dash },
  { key: 'failed_reason', width: '130px', render: j => j.failedReason ?? dash },
  { key: 'skip_count', width: '100px', align: 'end', render: j => j.skipCount },
  { key: 'worker_identity', width: '140px', render: j => j.workerIdentity ?? dash },
  { key: 'claimed_at', width: '150px', render: j => j.claimedAt ?? dash },
  { key: 'heartbeat_at', width: '150px', render: j => j.heartbeatAt ?? dash },
  { key: 'created_at', width: '150px', render: j => j.createdAt },
  { key: 'completed_at', width: '150px', render: j => j.completedAt ?? dash },
];

const DLQ_COLUMNS: Column<SimDlqRow>[] = [
  { key: 'id', width: '56px', render: d => d.id },
  { key: 'source', width: '112px', render: d => d.source },
  { key: 'entry_id', width: '90px', render: d => d.entryId ?? dash },
  { key: 'tenant_id', width: '80px', render: d => d.tenantId },
  { key: 'model_id', width: '76px', render: d => d.modelId },
  { key: 'reason', width: '180px', render: d => d.reason },
  {
    key: 'error_message',
    width: 'minmax(180px, 1fr)',
    render: d => d.errorMessage ?? dash,
  },
  { key: 'failed_at', width: '150px', render: d => d.failedAt },
  { key: 'retry_count', width: '106px', align: 'end', render: d => d.retryCount },
  {
    key: 'chunk_correlation_id',
    width: '260px',
    render: d => d.chunkCorrelationId,
  },
];
