'use client';

import { useId, useState } from 'react';
import CodeBlock from '@/components/CodeBlock';
import { useTranslations } from '@/lib/i18n';
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
import { defaultPageColumns } from '@/lib/sim/capacity';
import PageTable from './PageTable';
import { usePlayground } from './PlaygroundContext';
import TableView, { TABLE_ROW_LIMIT, type Column } from './TableView';
import styles from './WorldInspector.module.css';

type Group = 'registry' | 'data' | 'ops';

const GROUP_IDS: Group[] = ['registry', 'data', 'ops'];

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
  const t = useTranslations('playground');

  const versionRows: VersionRow[] = [
    { version: world.schemaVersion, updatedAt: world.schemaVersionUpdatedAt },
  ];

  return (
    <div className={styles.inspector}>
      <div className={styles.tabs} role="tablist" aria-label={t('worldInspector.tabsGroupLabel')}>
        {GROUP_IDS.map(id => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${panelId}-tab-${id}`}
            aria-selected={group === id}
            aria-controls={panelId}
            className={`${styles.tab} ${group === id ? styles.tabOn : ''}`}
            onClick={() => setGroup(id)}
          >
            {t(`worldInspector.groups.${id}.label`)}
          </button>
        ))}
      </div>

      <p className={styles.blurb}>{t(`worldInspector.groups.${group}.blurb`)}</p>

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
              note={t('worldInspector.models.note')}
              about={t('worldInspector.models.about')}
              rows={world.models}
              rowKey={m => m.id}
              columns={MODEL_COLUMNS}
              ddl={TABLE_DDL.stardust_models}
              empty={t('worldInspector.models.empty')}
            />
            <TableView<SimField>
              name="stardust_fields"
              note={t('worldInspector.fields.note')}
              about={t('worldInspector.fields.about')}
              rows={world.fields}
              rowKey={f => f.id}
              columns={FIELD_COLUMNS}
              ddl={TABLE_DDL.stardust_fields}
              empty={t('worldInspector.fields.empty')}
            />
            <TableView<SimPage>
              name="stardust_pages"
              note={t('worldInspector.pages.note')}
              about={
                <>
                  {t('worldInspector.pages.aboutBefore')}
                  <code>entry_slots_page_N</code>
                  {t('worldInspector.pages.aboutAfter')}
                  <code>information_schema.STATISTICS</code>
                  {t('worldInspector.pages.aboutEnd')}
                </>
              }
              rows={world.pages}
              rowKey={p => p.id}
              columns={PAGE_COLUMNS}
              ddl={TABLE_DDL.stardust_pages}
              empty={t('worldInspector.pages.empty')}
            />
            <TableView<SimSlot>
              name="stardust_slot_assignments"
              note={t('worldInspector.slots.note')}
              about={t('worldInspector.slots.about')}
              rows={world.slots}
              rowKey={s => s.id}
              columns={SLOT_COLUMNS}
              ddl={TABLE_DDL.stardust_slot_assignments}
              empty={t('worldInspector.slots.empty')}
            />
          </>
        )}

        {group === 'data' && (
          <>
            <TableView<SimEntry>
              name="entry_data"
              note={t('worldInspector.entries.note')}
              about={
                <>
                  {t('worldInspector.entries.aboutBefore')}
                  <code>fields</code>
                  {t('worldInspector.entries.aboutMid')}
                  <strong>name</strong>
                  {t('worldInspector.entries.aboutAfter')}
                </>
              }
              rows={world.entries}
              rowKey={e => e.id}
              columns={ENTRY_COLUMNS}
              ddl={TABLE_DDL.entry_data}
              maxRows={TABLE_ROW_LIMIT}
              empty={t('worldInspector.entries.empty')}
            />
            {world.pages.length === 0 ? (
              <div className={`panel ${styles.absent}`}>
                <div className="panel-head">
                  <span>entry_slots_page_N</span>
                  <span className="tag tag-json">{t('worldInspector.absentPage.tag')}</span>
                </div>
                <p>
                  {t('worldInspector.absentPage.body1')}
                  <code>i_str_NN</code>
                  {t('worldInspector.absentPage.body2')}
                  <code>i_int_NN</code>
                  {t('worldInspector.absentPage.body2')}
                  <code>i_num_NN</code>
                  {t('worldInspector.absentPage.body3')}
                  <code>i_dt_NN</code>
                  {t('worldInspector.absentPage.body4')}
                </p>
                <div className={styles.absentDdl}>
                  {/* Page 1 because that is what the first one will be called,
                      and the no-demand column set because nothing has asked for
                      a slot yet. Asked of the planner rather than restated, so
                      the preview and the real thing cannot drift. */}
                  <CodeBlock
                    code={pageDdl(1, defaultPageColumns())}
                    lang="sql"
                    title={t('worldInspector.absentPage.ddlTitle')}
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
              note={t('worldInspector.version.note')}
              about={t('worldInspector.version.about')}
              rows={versionRows}
              rowKey={() => 1}
              columns={VERSION_COLUMNS}
              ddl={TABLE_DDL.stardust_schema_version}
              empty={t('worldInspector.version.empty')}
            />
            <TableView<SimSyncRow>
              name="stardust_sync_queue"
              note={
                world.syncQueue.length === 0
                  ? t('worldInspector.syncQueue.noteEmpty')
                  : t('worldInspector.syncQueue.noteCount', { count: world.syncQueue.length })
              }
              maxRows={TABLE_ROW_LIMIT}
              about={t('worldInspector.syncQueue.about')}
              rows={world.syncQueue}
              rowKey={r => r.id}
              columns={SYNC_COLUMNS}
              ddl={TABLE_DDL.stardust_sync_queue}
              empty={t('worldInspector.syncQueue.empty')}
            />
            <TableView<SimCheckpoint>
              name="backfill_checkpoints"
              note={t('worldInspector.checkpoints.note')}
              about={t('worldInspector.checkpoints.about')}
              rows={world.checkpoints}
              rowKey={c => c.id}
              columns={CHECKPOINT_COLUMNS}
              ddl={TABLE_DDL.backfill_checkpoints}
              empty={t('worldInspector.checkpoints.empty')}
            />
            <TableView<SimImportJob>
              name="stardust_import_jobs"
              note={t('worldInspector.importJobs.note')}
              about={t('worldInspector.importJobs.about')}
              rows={world.importJobs}
              rowKey={j => j.id}
              columns={IMPORT_JOB_COLUMNS}
              ddl={TABLE_DDL.stardust_import_jobs}
              empty={t('worldInspector.importJobs.empty')}
            />
            <TableView<SimExportJob>
              name="stardust_export_jobs"
              note={t('worldInspector.exportJobs.note')}
              about={t('worldInspector.exportJobs.about')}
              rows={world.exportJobs}
              rowKey={j => j.id}
              columns={EXPORT_JOB_COLUMNS}
              ddl={TABLE_DDL.stardust_export_jobs}
              empty={t('worldInspector.exportJobs.empty')}
            />
            <TableView<SimDlqRow>
              name="stardust_reconciler_dlq"
              note={t('worldInspector.dlq.note')}
              about={t('worldInspector.dlq.about')}
              rows={world.dlq}
              rowKey={d => d.id}
              columns={DLQ_COLUMNS}
              ddl={TABLE_DDL.stardust_reconciler_dlq}
              empty={t('worldInspector.dlq.empty')}
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
