'use client';

import { useId, useState, type ReactNode } from 'react';
import CodeBlock from '@/components/CodeBlock';
import styles from './TableView.module.css';

export type Column<Row> = {
  /** The real MySQL column name. Rendered as the header, verbatim. */
  key: string;
  /**
   * Header override, for a column that is **not** a database column.
   *
   * Row controls need somewhere to live, and rendering them under a blank
   * header would both leave a screen reader with an unlabelled column and
   * quietly imply the table has a column it does not. A synthetic column says
   * so here instead; everything else leaves this alone and the header stays
   * the verbatim column name.
   */
  header?: ReactNode;
  /** Grid track. Use `1fr` (or `minmax`) for the column that should absorb slack. */
  width?: string;
  render: (row: Row) => ReactNode;
  align?: 'start' | 'end';
  /**
   * Rendered beside the header. Used to mark a page's *indexed* slot columns:
   * a column and an index on it are different things, and this is where that
   * difference is visible.
   */
  tag?: ReactNode;
};

type Props<Row> = {
  /** The real table name, e.g. `stardust_slot_assignments`. */
  name: string;
  /** Right-hand chip in the panel head — what this table is *for*. */
  note?: ReactNode;
  /** One line under the head: what the table holds and who writes it. */
  about?: ReactNode;
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string | number;
  /**
   * Shown instead of rows when there are none. Required, and deliberately so:
   * several of these tables are empty for most of the walkthrough, and an
   * empty table has to read as deliberately empty rather than as broken.
   */
  empty: ReactNode;
  /**
   * The real `CREATE TABLE`, revealed by a toggle in the head. The section's
   * claim is that these columns are the engine's columns; without this there
   * is no way for a reader to check it.
   */
  ddl?: string;
  /** Extra controls in the head, left of the DDL toggle. */
  actions?: ReactNode;
  /**
   * Render at most this many rows, keeping the **most recent**.
   *
   * From the write path onward `entry_data` and `stardust_sync_queue` grow by
   * a row per write, and an extension page draws up to 60 columns for each of
   * them — a seeded model is tens of thousands of cells. The newest rows are
   * kept rather than the oldest because they are the ones a visitor just
   * caused, and because the write choreography needs the row it landed in to
   * actually be in the DOM.
   *
   * The truncation is announced in the head, and says whose limit it is: a
   * silently shortened table in the one section whose whole promise is "these
   * are the real rows" would be worse than a slow one.
   */
  maxRows?: number;
  /** Per-row class hook — a row a write just landed in, a soft-deleted row. */
  rowClass?: (row: Row) => string | undefined;
  /**
   * Ref registration per rendered row, so a caller can fly a ghost to one.
   * Keyed on the row rather than an index, because a sliced index means
   * nothing to the caller.
   */
  registerRow?: (row: Row) => ((el: HTMLElement | null) => void) | undefined;
};

/**
 * How many rows a growable table renders.
 *
 * A presentation limit, not an engine rule, which is why it lives here rather
 * than in `lib/sim/`.
 */
export const TABLE_ROW_LIMIT = 25;

/**
 * Row states a caller can ask for through `rowClass`.
 *
 * Exported rather than left in the stylesheet so a caller does not have to
 * import another component's CSS module to name one — the hashed class names
 * are this file's business.
 */
export const ROW_CLASS = {
  /** A row a write has landed in but whose ghost is still in flight. */
  landing: styles.landing,
  /** Soft-deleted: still in `entry_data`, gone from every read. */
  deleted: styles.deleted,
} as const;

/**
 * One database table, rendered.
 *
 * Extracted from the landing page's bespoke renderer rather than shared with
 * it — the landing page is shipped and working, and coupling four proven demos
 * to a growing simulator trades a stable asset for a convenience. The two are
 * expected to diverge.
 *
 * It is a CSS grid rather than a `<table>` because every row here is a mix of
 * text, status chips and JSON, and the column rhythm has to be declared once
 * by the caller. Semantics are restored with explicit roles so it still reads
 * as a table to a screen reader.
 */
export default function TableView<Row>({
  name,
  note,
  about,
  columns,
  rows,
  rowKey,
  empty,
  ddl,
  actions,
  maxRows,
  rowClass,
  registerRow,
}: Props<Row>) {
  const [showDdl, setShowDdl] = useState(false);
  const ddlId = useId();

  const template = columns.map(c => c.width ?? 'minmax(80px, 1fr)').join(' ');

  const truncated = maxRows !== undefined && rows.length > maxRows;
  const shown = truncated ? rows.slice(-(maxRows as number)) : rows;

  return (
    <div className={`panel ${styles.table}`}>
      <div className="panel-head">
        <span className={styles.name}>{name}</span>
        <span className={styles.headRight}>
          {truncated && (
            <span className={styles.truncated}>
              showing the {shown.length} most recent of {rows.length} rows
            </span>
          )}
          {note && <span className="tag tag-json">{note}</span>}
          {actions}
          {ddl !== undefined && (
            <button
              type="button"
              className={`${styles.toggle} ${showDdl ? styles.toggleOn : ''}`}
              aria-expanded={showDdl}
              aria-controls={ddlId}
              onClick={() => setShowDdl(v => !v)}
            >
              {showDdl ? 'hide DDL' : 'DDL'}
            </button>
          )}
        </span>
      </div>

      {ddl !== undefined && (
        <div id={ddlId} hidden={!showDdl} className={styles.ddl}>
          <CodeBlock code={ddl} lang="sql" copyable />
        </div>
      )}

      {/* Outside `.body`, which scrolls horizontally with a wide table. */}
      {about && <p className={styles.about}>{about}</p>}

      <div className={styles.body}>
        <div className={styles.grid} role="table" aria-label={name}>
          <div className={styles.head} role="row" style={{ gridTemplateColumns: template }}>
            {columns.map(c => (
              <span
                key={c.key}
                role="columnheader"
                className={c.align === 'end' ? styles.end : undefined}
              >
                {c.header ?? c.key}
                {c.tag}
              </span>
            ))}
          </div>

          {shown.map(row => (
            <div
              key={rowKey(row)}
              role="row"
              ref={registerRow?.(row)}
              className={`${styles.row} ${rowClass?.(row) ?? ''}`}
              style={{ gridTemplateColumns: template }}
            >
              {columns.map(c => (
                <span
                  key={c.key}
                  role="cell"
                  className={`${styles.cell} ${c.align === 'end' ? styles.end : ''}`}
                >
                  {c.render(row)}
                </span>
              ))}
            </div>
          ))}
        </div>

        {rows.length === 0 && <p className={styles.empty}>{empty}</p>}
        {truncated && (
          <p className={styles.truncatedNote}>
            {rows.length - shown.length} older rows are in the table and not drawn.
            That is this page&rsquo;s limit, not the database&rsquo;s — a browser will
            not render tens of thousands of cells, and MySQL does not care.
          </p>
        )}
      </div>
    </div>
  );
}
