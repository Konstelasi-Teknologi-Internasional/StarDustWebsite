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
   * Which of this page's slot columns carry a real index.
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

/**
 * `backfill_checkpoints`. One row per running lifecycle, keyed by a
 * thirteen-character `jobName` prefix (`retype_field_`, `rename_field_`,
 * `delete_field_`, `delete_model_`).
 */
export interface SimCheckpoint {
  jobName: string;
  cursorId: number;
  /** Retype only: the type values are coercing *from*. */
  sourceDeclaredType: DeclaredType | null;
  totalRows: number;
  updatedAt: string;
}

export type JobKind = 'import' | 'export';
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

/** `stardust_import_jobs` / `stardust_export_jobs`, collapsed into one shape. */
export interface SimJob {
  id: number;
  kind: JobKind;
  tenantId: number;
  modelId: number | null;
  status: JobStatus;
  format: 'csv' | 'json' | null;
  cursorId: number | null;
  rowsWritten: number;
  artifactPath: string | null;
  failedReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** `stardust_reconciler_dlq`. Has no FK to `entry_data`, on purpose. */
export interface SimDlqRow {
  id: number;
  entryId: number;
  reason: string;
  createdAt: string;
}
