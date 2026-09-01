'use client';

import type { ReactNode } from 'react';
import styles from './TableView.module.css';

export type Column<Row> = {
  /** The real MySQL column name. Rendered as the header, verbatim. */
  key: string;
  /** Grid track. Use `1fr` (or `minmax`) for the column that should absorb slack. */
  width?: string;
  render: (row: Row) => ReactNode;
  align?: 'start' | 'end';
};

type Props<Row> = {
  /** The real table name, e.g. `stardust_slot_assignments`. */
  name: string;
  /** Right-hand chip in the panel head — what this table is *for*. */
  note?: ReactNode;
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string | number;
  /**
   * Shown instead of rows when there are none. Required, and deliberately so:
   * several of these tables are empty for most of the walkthrough, and an
   * empty table has to read as deliberately empty rather than as broken.
   */
  empty: ReactNode;
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
  columns,
  rows,
  rowKey,
  empty,
}: Props<Row>) {
  const template = columns.map(c => c.width ?? 'minmax(80px, 1fr)').join(' ');

  return (
    <div className={`panel ${styles.table}`}>
      <div className="panel-head">
        <span className={styles.name}>{name}</span>
        {note && <span className="tag tag-json">{note}</span>}
      </div>

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
