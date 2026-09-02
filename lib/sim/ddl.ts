/**
 * The schema, verbatim.
 *
 * Section B claims that every table it shows has the same names, columns and
 * nullability as the ones `bootstrap()` creates. Nothing on the page made that
 * claim checkable, so this module holds the DDL itself and the inspector puts
 * it one click from the rows.
 *
 * PROVENANCE — transcribed from the engine's `src/Bootstrap/Bootstrapper.php`
 * and `src/Page/PageProvisioner.php` as of 2026-09-01. Like
 * {@link ./events.ts}, this is a checked-in *mirror*: the engine is a separate
 * repository, so nothing in this repo can prove it still matches. When the
 * engine changes its DDL, change this in the same commit — a stale copy turns
 * the one section that teaches column names into the one section that lies
 * about them.
 *
 * Two conventions here, both deliberate:
 *
 * 1. **The `ALTER`s are shown as `ALTER`s.** Several columns and indexes are
 *    not in their table's `CREATE`: they were added later and arrive through
 *    an idempotent `information_schema` probe plus an `ALTER TABLE`, so that
 *    an existing deployment picks them up on its next bootstrap. Folding them
 *    into the `CREATE` would read more tidily and would be false, and the
 *    migration pattern is worth seeing anyway.
 * 2. **`entry_slots_page_N` is a function, not a constant.** Its column list
 *    is fixed but its *indexes* are decided per page at provision time, which
 *    is the whole of the Index Provisioning Policy.
 */

import { FAMILY_OF, FAMILY_SLOT_COUNTS, slotColumnName } from './world';
import type { DeclaredType, SlotFamily } from './types';

/** Every table `bootstrap()` creates. Extension pages are not among them. */
export type TableName =
  | 'entry_data'
  | 'stardust_sync_queue'
  | 'stardust_models'
  | 'stardust_fields'
  | 'stardust_pages'
  | 'stardust_slot_assignments'
  | 'stardust_schema_version'
  | 'stardust_export_jobs'
  | 'stardust_import_jobs'
  | 'stardust_reconciler_dlq'
  | 'backfill_checkpoints';

export const TABLE_DDL: Record<TableName, string> = {
  entry_data: `CREATE TABLE IF NOT EXISTS entry_data (
    id          BIGINT       NOT NULL AUTO_INCREMENT,
    tenant_id   BIGINT       NOT NULL,
    model_id    INT          NOT NULL,
    created_at  DATETIME     NOT NULL,
    updated_at  DATETIME     NOT NULL,
    deleted_at  DATETIME         NULL DEFAULT NULL,
    fields      JSON         NOT NULL,
    PRIMARY KEY (id),
    KEY ix_entry_data_tenant_model (tenant_id, model_id),
    KEY ix_entry_data_tenant_lifecycle (tenant_id, deleted_at, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  stardust_sync_queue: `CREATE TABLE IF NOT EXISTS stardust_sync_queue (
    id          BIGINT   NOT NULL AUTO_INCREMENT,
    entry_id    BIGINT   NOT NULL,
    created_at  DATETIME NOT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci

-- Added later, as its own reviewable schema change. Deleting a model's queue
-- rows by entry_id without this is a full scan: measured on 8.0.13, deleting
-- ten rows out of a hundred thousand took 100,261 exclusive record locks
-- instead of 30 -- held for a whole chunk transaction, which would block the
-- write path's own enqueue.
CREATE INDEX ix_sync_queue_entry
    ON stardust_sync_queue (entry_id)`,

  stardust_models: `CREATE TABLE IF NOT EXISTS stardust_models (
    id          INT          NOT NULL AUTO_INCREMENT,
    tenant_id   BIGINT       NOT NULL,
    name        VARCHAR(128) NOT NULL,
    created_at  DATETIME     NOT NULL,
    deleted_at  DATETIME         NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY ux_models_tenant_name (tenant_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci

-- deleted_at is in the CREATE above, so this only fires on a database
-- bootstrapped before the column existed. Note what is still absent: there is
-- no updated_at on this table, which is why renaming a model needs no clock.
ALTER TABLE stardust_models
    ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL`,

  stardust_fields: `CREATE TABLE IF NOT EXISTS stardust_fields (
    id              BIGINT       NOT NULL AUTO_INCREMENT,
    model_id        INT          NOT NULL,
    name            VARCHAR(128) NOT NULL,
    declared_type   ENUM('string','int','numeric','datetime') NOT NULL,
    is_filterable   BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at      DATETIME     NOT NULL,
    updated_at      DATETIME     NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY ux_fields_model_name (model_id, name),
    CONSTRAINT fk_fields_model
        FOREIGN KEY (model_id) REFERENCES stardust_models (id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci

-- Both added later, both drain-window markers rather than data. entry_data.fields
-- is keyed by field NAME, so a rename cannot be a registry update -- it is a
-- rewrite of every row in the model, and previous_name is what lets a read
-- answer correctly while that rewrite is still running.
ALTER TABLE stardust_fields
    ADD COLUMN previous_name VARCHAR(128) NULL DEFAULT NULL

-- Non-null means "a deletion is in flight". It is not a soft-delete tier:
-- there is no undelete, and the purge's last chunk removes the row outright.
ALTER TABLE stardust_fields
    ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL`,

  stardust_pages: `CREATE TABLE IF NOT EXISTS stardust_pages (
    id              INT          NOT NULL AUTO_INCREMENT,
    table_name      VARCHAR(64)  NOT NULL,
    provisioned_at  DATETIME     NOT NULL,
    provisioned_by  VARCHAR(128) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY ux_pages_table_name (table_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci

-- Four columns, and none of them records which of the page's slot columns
-- carry an index. That is not an omission: the engine reads it back out of
-- information_schema.STATISTICS when it needs it.`,

  stardust_slot_assignments: `CREATE TABLE IF NOT EXISTS stardust_slot_assignments (
    id                  BIGINT       NOT NULL AUTO_INCREMENT,
    page_id             INT          NOT NULL,
    slot_column         VARCHAR(16)  NOT NULL,
    slot_type           ENUM('str','int','num','dt') NOT NULL,
    field_id            BIGINT           NULL DEFAULT NULL,
    status              ENUM('free','assigned','tombstoned','backfilling','ready')
                        NOT NULL DEFAULT 'free',
    sweep_cursor_id     BIGINT           NULL DEFAULT NULL,
    tombstoned_at       DATETIME         NULL DEFAULT NULL,
    updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                        ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY ux_slot_assignments_page_column (page_id, slot_column),
    KEY ix_slot_assignments_status_type (status, slot_type),
    KEY ix_slot_assignments_page_status (page_id, status),
    CONSTRAINT fk_slot_assignments_page
        FOREIGN KEY (page_id) REFERENCES stardust_pages (id),
    CONSTRAINT fk_slot_assignments_field
        FOREIGN KEY (field_id) REFERENCES stardust_fields (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci

-- "At most one live slot per field", enforced by the database rather than by
-- convention. The CASE yields field_id only while the row is live, and NULLs
-- are exempt from UNIQUE -- so a tombstoned or free row never blocks the next
-- reservation. MySQL has no CREATE INDEX IF NOT EXISTS, which is why this is a
-- separate probe-then-create step rather than a line in the CREATE above.
CREATE UNIQUE INDEX ux_slot_assignments_field_live
    ON stardust_slot_assignments (
        (CASE WHEN status IN ('assigned', 'backfilling', 'ready')
              THEN field_id END)
    )

-- An annotation for operators, not a control: how many chunks a sweep of this
-- slot skipped over. It survives the reclaim back to free on purpose.
ALTER TABLE stardust_slot_assignments
    ADD COLUMN sweep_gap_count INT NOT NULL DEFAULT 0`,

  stardust_schema_version: `CREATE TABLE IF NOT EXISTS stardust_schema_version (
    id          TINYINT          NOT NULL,
    version     BIGINT UNSIGNED  NOT NULL DEFAULT 0,
    updated_at  DATETIME         NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT ck_schema_version_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci

-- The CHECK is defence in depth, and only on 8.0.16+: 8.0.13 through 8.0.15
-- parse CHECK clauses and silently drop them. What actually guarantees the
-- singleton on every supported version is the primary key plus this seed.
INSERT INTO stardust_schema_version (id, version, updated_at)
VALUES (1, 0, ?)
ON DUPLICATE KEY UPDATE id = id`,

  stardust_export_jobs: `CREATE TABLE IF NOT EXISTS stardust_export_jobs (
    id               BIGINT        NOT NULL AUTO_INCREMENT,
    tenant_id        BIGINT        NOT NULL,
    status           ENUM('pending','processing','completed','failed')
                     NOT NULL DEFAULT 'pending',
    filter           JSON          NOT NULL,
    format           ENUM('csv','json') NOT NULL,
    last_cursor      BIGINT            NULL DEFAULT NULL,
    artifact_path    VARCHAR(512)      NULL DEFAULT NULL,
    failed_reason    VARCHAR(64)       NULL DEFAULT NULL,
    skip_count       INT UNSIGNED  NOT NULL DEFAULT 0,
    worker_identity  VARCHAR(128)      NULL DEFAULT NULL,
    claimed_at       DATETIME          NULL DEFAULT NULL,
    heartbeat_at     DATETIME          NULL DEFAULT NULL,
    created_at       DATETIME      NOT NULL,
    completed_at     DATETIME          NULL DEFAULT NULL,
    PRIMARY KEY (id),
    KEY ix_export_jobs_status_created (status, created_at),
    KEY ix_export_jobs_tenant_status (tenant_id, status),
    KEY ix_export_jobs_status_heartbeat (status, heartbeat_at),
    KEY ix_export_jobs_completed (completed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci

-- There is no model_id column: the id is stamped into the top level of the
-- filter JSON, alongside the consumer's own filter tree preserved verbatim.
-- The (status, heartbeat_at) key is what lets a worker find a job whose
-- claimant stopped heartbeating and take it over.`,

  stardust_import_jobs: `CREATE TABLE IF NOT EXISTS stardust_import_jobs (
    id               BIGINT        NOT NULL AUTO_INCREMENT,
    tenant_id        BIGINT        NOT NULL,
    status           ENUM('pending','processing','completed','failed')
                     NOT NULL DEFAULT 'pending',
    idempotency_key  VARCHAR(128)      NULL DEFAULT NULL,
    artifact_path    VARCHAR(512) NOT NULL,
    entry_count      INT UNSIGNED NOT NULL,
    manifest         JSON              NULL DEFAULT NULL,
    failed_reason    VARCHAR(64)       NULL DEFAULT NULL,
    worker_identity  VARCHAR(128)      NULL DEFAULT NULL,
    claimed_at       DATETIME          NULL DEFAULT NULL,
    heartbeat_at     DATETIME          NULL DEFAULT NULL,
    created_at       DATETIME     NOT NULL,
    completed_at     DATETIME          NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY ux_import_jobs_tenant_idempotency (tenant_id, idempotency_key),
    KEY ix_import_jobs_status_created (status, created_at),
    KEY ix_import_jobs_tenant_status (tenant_id, status),
    KEY ix_import_jobs_status_heartbeat (status, heartbeat_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci

-- The UNIQUE is the idempotency contract, enforced by the database rather than
-- by a check-then-insert. MySQL lets a UNIQUE hold any number of NULLs, so
-- submissions without a key never collide with each other.
-- manifest is written chunk by chunk, not once at the end: it doubles as the
-- resume point when a worker picks the job back up.`,

  stardust_reconciler_dlq: `CREATE TABLE IF NOT EXISTS stardust_reconciler_dlq (
    id                    BIGINT        NOT NULL AUTO_INCREMENT,
    source                ENUM('sync_queue','bulk_import') NOT NULL,
    entry_id              BIGINT            NULL DEFAULT NULL,
    tenant_id             BIGINT        NOT NULL,
    model_id              INT           NOT NULL,
    reason                ENUM('malformed_json','missing_entry_data','schema_incompatibility','other') NOT NULL,
    error_message         TEXT              NULL,
    failed_at             DATETIME      NOT NULL,
    retry_count           INT           NOT NULL DEFAULT 0,
    chunk_correlation_id  VARCHAR(36)   NOT NULL,
    PRIMARY KEY (id),
    KEY ix_dlq_source_failed_at (source, failed_at),
    KEY ix_dlq_entry (entry_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci

-- No foreign key to entry_data, on purpose. One of the reasons above is
-- missing_entry_data, which only means anything if a row here can outlive the
-- row that produced it -- and that is also why tenant_id and model_id are
-- stored rather than joined for.`,

  backfill_checkpoints: `CREATE TABLE IF NOT EXISTS backfill_checkpoints (
    id                  BIGINT       NOT NULL AUTO_INCREMENT,
    job_name            VARCHAR(128) NOT NULL,
    last_processed_id   BIGINT       NOT NULL DEFAULT 0,
    status              ENUM('running','paused','completed','failed')
                        NOT NULL DEFAULT 'running',
    started_at          DATETIME     NOT NULL,
    updated_at          DATETIME     NOT NULL,
    completed_at        DATETIME         NULL DEFAULT NULL,
    last_error          VARCHAR(512)     NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY ux_backfill_job_name (job_name),
    KEY ix_backfill_status_updated (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci

-- job_name carries which lifecycle a row belongs to as a thirteen-character
-- prefix: retype_field_, rename_field_, delete_field_, delete_model_. Equal
-- lengths so every claim query can share one SUBSTRING.
-- Only a retype needs this column: retyping overwrites the field's
-- declared_type, so the type its values are coercing FROM has nowhere else to
-- live once the lifecycle has started.
ALTER TABLE backfill_checkpoints
    ADD COLUMN source_declared_type VARCHAR(16) NULL DEFAULT NULL`,
};

/** The MySQL type each slot family's columns are declared with. */
const FAMILY_SQL_TYPE: Record<SlotFamily, string> = {
  str: 'TEXT',
  int: 'BIGINT',
  num: 'DOUBLE',
  dt: 'DATETIME',
};

/**
 * The prefix length of a string slot's composite index.
 *
 * 766 utf8mb4 characters at 4 bytes each, plus the 8-byte tenant_id, is 3072 —
 * exactly InnoDB's key-size limit under `ROW_FORMAT=DYNAMIC`. It is a prefix
 * rather than the whole column and the filters stay exact anyway, because
 * MySQL rechecks the full value behind every prefix-index access.
 */
export const STRING_INDEX_PREFIX = 766;

/** Every slot column of a page, in the order the provisioner emits them. */
export function allSlotColumns(): string[] {
  const out: string[] = [];
  for (const family of Object.keys(FAMILY_SLOT_COUNTS) as SlotFamily[]) {
    for (let i = 1; i <= FAMILY_SLOT_COUNTS[family]; i++) {
      out.push(slotColumnName(family, i));
    }
  }
  return out;
}

/** The slot family a column name belongs to — `i_str_07` is `str`. */
export function familyOfColumn(column: string): SlotFamily {
  return column.split('_')[1] as SlotFamily;
}

/**
 * The MySQL type a field of this declared type would occupy.
 *
 * Exported because the model builder was carrying its own copy of this
 * mapping, and the copy had drifted — it claimed `numeric` was `DECIMAL`,
 * where the engine's provisioner and the DDL twelve lines above both say
 * `DOUBLE`. Two copies of a rule about slot columns is one too many, and the
 * one in a component was the wrong one twice over: wrong on the facts, and
 * wrong to be there at all.
 */
export function slotSqlType(declaredType: DeclaredType): string {
  return FAMILY_SQL_TYPE[FAMILY_OF[declaredType]];
}

/**
 * The DDL for one extension page.
 *
 * A port of the engine's `PageProvisioner::buildPageDdl()`. Every page has the
 * same 60 columns; what differs between them is `filterableSlots`, decided per
 * page when it is provisioned, from the fields that actually need an index.
 * Indexing all 60 by default would be the cost this design exists to avoid.
 */
export function pageDdl(pageNumber: number, filterableSlots: string[]): string {
  const tableName = `entry_slots_page_${pageNumber}`;
  const lines = [
    `CREATE TABLE IF NOT EXISTS ${tableName} (`,
    '    entry_id  BIGINT NOT NULL,',
    '    tenant_id BIGINT NOT NULL,',
  ];

  for (const col of allSlotColumns()) {
    lines.push(`    ${col} ${FAMILY_SQL_TYPE[familyOfColumn(col)]} NULL DEFAULT NULL,`);
  }

  lines.push('    PRIMARY KEY (entry_id),');
  lines.push(`    KEY ix_${tableName}_tenant (tenant_id),`);

  for (const slot of filterableSlots) {
    const expr =
      familyOfColumn(slot) === 'str' ? `${slot}(${STRING_INDEX_PREFIX})` : slot;
    lines.push(`    KEY ix_${tableName}_${slot} (tenant_id, ${expr}),`);
  }

  lines.push(
    `    CONSTRAINT fk_${tableName}_entry FOREIGN KEY (entry_id) REFERENCES entry_data (id) ON DELETE CASCADE`,
  );
  lines.push(
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC',
  );
  lines.push('');
  lines.push(
    '-- ROW_FORMAT=DYNAMIC is load-bearing rather than tidy: COMPACT and REDUNDANT',
  );
  lines.push('-- cap an index key at 767 bytes, and the 766-character string prefix above');
  lines.push('-- needs 3072. Getting it wrong fails the CREATE outright, errno 1071.');
  lines.push('-- String slots are TEXT for a related reason: 25 VARCHAR(4096) columns');
  lines.push("-- blow MySQL's 65,535-byte row-definition limit, errno 1118. TEXT costs");
  lines.push('-- about twelve bytes of that budget instead of sixteen thousand.');

  return lines.join('\n');
}
