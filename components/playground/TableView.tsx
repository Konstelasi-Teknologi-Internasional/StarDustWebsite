'use client';

import { useId, useState, type ReactNode } from 'react';
import CodeBlock from '@/components/CodeBlock';
import styles from './TableView.module.css';

export type Column<Row> = {
  /** The real MySQL column name. Rendered as the header, verbatim. */
  key: string;
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
};

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
}: Props<Row>) {
  const [showDdl, setShowDdl] = useState(false);
  const ddlId = useId();

  const template = columns.map(c => c.width ?? 'minmax(80px, 1fr)').join(' ');

  return (
    <div className={`panel ${styles.table}`}>
      <div className="panel-head">
        <span className={styles.name}>{name}</span>
        <span className={styles.headRight}>
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
                {c.key}
                {c.tag}
              </span>
            ))}
          </div>

          {rows.map(row => (
            <div
              key={rowKey(row)}
              role="row"
              className={styles.row}
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
      </div>
    </div>
  );
}
