/**
 * The simulated database, typed.
 *
 * This file is a mirror of the engine's bootstrap DDL — every interface below
 * is one table, and the field names are the column names. It was written
 * against `src/Bootstrap/Bootstrapper.php` in the engine repo rather than from
 * memory, because the whole point of the playground is that a visitor who then
 * goes and reads the real schema finds the same shapes.
 *
 * Nothing here has behaviour. Behaviour lives in the sibling modules, and only
 * there — no component may encode a rule about slots, statuses or daemons.
 */

/** `stardust_fields.declared_type` — a closed ENUM in the real schema. */
export type DeclaredType = 'string' | 'int' | 'numeric' | 'datetime';

/** `stardust_slot_assignments.slot_type`, and the `i_{family}_NN` infix. */
export type SlotFamily = 'str' | 'int' | 'num' | 'dt';

/**
 * `stardust_slot_assignments.status`. Five states, closed at the database
 * level. `assigned | backfilling | ready` are the live ones; only `ready`
 * (and `assigned`) can serve a filter, which is the distinction section E
 * is built on.
 */
export type SlotStatus = 'free' | 'assigned' | 'tombstoned' | 'backfilling' | 'ready';

/**
 * `stardust_models`.
 *
 * There is deliberately no `updatedAt`: `stardust_models` has no `updated_at`
 * column, which is why the engine's `ModelRenamer` is the one registry
 * collaborator that takes no clock. Don't add one for symmetry with
 * {@link SimField} — the asymmetry is real.
 */
export interface SimModel {
  id: number;
  tenantId: number;
  name: string;
  createdAt: string;
  /** ADR 0038 drain marker. Non-null means "this model is being deleted". */
  deletedAt: string | null;
}

/**
 * `stardust_fields`.
 *
 * `previousName` and `deletedAt` are the two bridge markers. Nothing sets
 * either until the schema-change stage, but they are columns rather than API
 * surface, and section F is unwritable without them:
 *
 * - `previousName` non-null means a rename is in flight — `entry_data.fields`
 *   is keyed by field *name*, so some payloads are still on the old key.
 * - `deletedAt` non-null means a deletion is in flight. It is a drain-window
 *   marker, not a soft-delete tier: there is no undelete.
 */
export interface SimField {
  id: number;
  modelId: number;
  name: string;
  declaredType: DeclaredType;
  /** Registry *intent*. A field is only queryable once a slot goes live. */
  isFilterable: boolean;
  previousName: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `stardust_pages`. One row per `entry_slots_page_N` extension table. */
export interface SimPage {
  id: number;
  tableName: string;
  provisionedAt: string;
  provisionedBy: string;
  /**
   * This page's slot columns. Every one of them carries an index.
   *
   * It used to name the indexed *subset* of a fixed sixty; since a page is
   * created with exactly the columns it indexes, the subset is the whole set,
   * and the page's size is readable here and nowhere else.
   *
   * The engine stores this nowhere — it derives it from
   * `information_schema.STATISTICS` at runtime. Modelling it as a property of
   * the *page* rather than as a column on the assignment row keeps that
   * honest, and is what section B's table view has to show.
   */
  indexedColumns: string[];
}

/** `stardust_slot_assignments`. One row per slot column per page. */
export interface SimSlot {
  id: number;
  pageId: number;
  slotColumn: string;
  slotType: SlotFamily;
  fieldId: number | null;
  status: SlotStatus;
  sweepCursorId: number | null;
  tombstonedAt: string | null;
  /** Liberator annotation: chunks its sweep skipped over. Survives reclaim. */
  sweepGapCount: number;
  updatedAt: string;
}

/**
 * `entry_data`, plus the extension-page rows that mirror it.
 *
 * `fields` is keyed by field **name**, not by field id. That is not an
 * incidental encoding choice — it is the reason renaming a field is a rewrite
 * of every row in the model rather than a registry update, and the reason a
 * rename needs a bridge at all.
 *
 * `slots` is the `entry_slots_page_N` side: page id → column → value. It is a
 * derived mirror; `fields` is always the complete system of record.
 */
export interface SimEntry {
  id: number;
  tenantId: number;
  modelId: number;
  fields: Record<string, unknown>;
  slots: Record<number, Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** `stardust_sync_queue`. Deliberately tiny — the ADR 0007 backfill debt. */
export interface SimSyncRow {
  id: number;
  entryId: number;
  createdAt: string;
}

/** `backfill_checkpoints.status`. Not the slot ENUM — a different four states. */
export type CheckpointStatus = 'running' | 'paused' | 'completed' | 'failed';

/**
 * `backfill_checkpoints`. One row per running lifecycle, keyed by a
 * thirteen-character `jobName` prefix (`retype_field_`, `rename_field_`,
 * `delete_field_`, `delete_model_`).
 *
 * There is deliberately no total-row count: the table has no such column, and
 * a progress denominator is something a caller derives from the rows it is
 * draining rather than something the checkpoint stores.
 */
export interface SimCheckpoint {
  id: number;
  jobName: string;
  lastProcessedId: number;
  status: CheckpointStatus;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
  /** Retype only: the type values are coercing *from*. */
  sourceDeclaredType: DeclaredType | null;
}

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * `stardust_import_jobs`.
 *
 * A sibling of {@link SimExportJob} rather than a variant of it. The two are
 * separate tables with different columns and independent auto-increments, and
 * collapsing them into one shape would mean rendering a table name that does
 * not exist. What they genuinely share is the claim protocol —
 * `workerIdentity` / `claimedAt` / `heartbeatAt` — because both are drained by
 * multi-worker daemons that recover an abandoned claim from a lapsed
 * heartbeat.
 */
export interface SimImportJob {
  id: number;
  tenantId: number;
  status: JobStatus;
  /** UNIQUE per tenant, and NULL-able: unkeyed submissions never collide. */
  idempotencyKey: string | null;
  artifactPath: string;
  entryCount: number;
  /** Written chunk by chunk — it doubles as the resume checkpoint. */
  manifest: Record<string, unknown> | null;
  failedReason: string | null;
  workerIdentity: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * `stardust_export_jobs`.
 *
 * `filter` holds a `{model_id, filter}` envelope: the engine stamps the model
 * id at the top level and preserves the consumer's original QueryFilter
 * verbatim underneath, so the wire-format validator never has to peel out the
 * engine's own stamping.
 */
export interface SimExportJob {
  id: number;
  tenantId: number;
  status: JobStatus;
  /** The `{model_id, filter}` envelope, not the consumer's filter alone. */
  filter: Record<string, unknown>;
  format: 'csv' | 'json';
  lastCursor: number | null;
  artifactPath: string | null;
  failedReason: string | null;
  skipCount: number;
  workerIdentity: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** Which work source produced a DLQ row. */
export type DlqSource = 'sync_queue' | 'bulk_import';

/** `stardust_reconciler_dlq.reason`, a closed ENUM. */
export type DlqReason =
  | 'malformed_json'
  | 'missing_entry_data'
  | 'schema_incompatibility'
  | 'other';

/**
 * `stardust_reconciler_dlq`.
 *
 * `entryId` is nullable *and* unconstrained. There is no FK to `entry_data`
 * on purpose — the `missing_entry_data` reason exists precisely so that a DLQ
 * row outlives the row that produced it, which a foreign key would forbid.
 * That is why `tenantId` and `modelId` are stored here rather than joined for:
 * once the entry is gone they are the only way to know whose it was.
 */
export interface SimDlqRow {
  id: number;
  source: DlqSource;
  entryId: number | null;
  tenantId: number;
  modelId: number;
  reason: DlqReason;
  errorMessage: string | null;
  failedAt: string;
  retryCount: number;
  chunkCorrelationId: string;
}
