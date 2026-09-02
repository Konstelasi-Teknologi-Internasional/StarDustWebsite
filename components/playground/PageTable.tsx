'use client';

import { useState } from 'react';
import { allSlotColumns, pageDdl } from '@/lib/sim/ddl';
import type { SimEntry, SimPage } from '@/lib/sim/types';
import { slotColumnsInUse, SLOTS_PER_PAGE, type SimWorld } from '@/lib/sim/world';
import TableView, { TABLE_ROW_LIMIT, type Column } from './TableView';
import styles from './PageTable.module.css';

type Props = {
  page: SimPage;
  world: SimWorld;
};

/**
 * One `entry_slots_page_N` extension table.
 *
 * Its own component because it owns a piece of view state — how many of the 60
 * slot columns to show — and a hook cannot live inside `pages.map()`.
 *
 * Two facts this view exists to keep straight, both easy to blur:
 *
 * 1. **Every page has all 60 columns**, whether or not a field is using them.
 *    Showing only the occupied ones by default keeps the table readable, but
 *    the toggle has to be there or the empty 55 stop existing.
 * 2. **A column and an index on that column are different things.** Which of
 *    these columns are indexed was decided when the page was provisioned, and
 *    the engine stores the answer nowhere — it reads it back out of
 *    `information_schema` when it needs it. So it is marked on the *column
 *    header*, as a property of the page, and never as a field on the slot
 *    assignment row.
 */
export default function PageTable({ page, world }: Props) {
  const [showAll, setShowAll] = useState(false);

  // Which columns are spoken for. The rule is the core's, not this
  // component's — and it is wider than "live" on purpose, so that a
  // tombstoned column keeps showing its residue until the sweep clears it.
  const occupied = slotColumnsInUse(world, page.id);

  const slotColumns = showAll
    ? allSlotColumns()
    : allSlotColumns().filter(col => occupied.has(col));

  const columns: Column<SimEntry>[] = [
    { key: 'entry_id', width: '80px', render: e => e.id },
    { key: 'tenant_id', width: '80px', render: e => e.tenantId },
    ...slotColumns.map<Column<SimEntry>>(col => ({
      key: col,
      width: 'minmax(96px, 1fr)',
      tag: page.indexedColumns.includes(col) ? (
        <span className={styles.indexed} title="indexed on this page">
          {' '}
          ●
        </span>
      ) : undefined,
      render: e => {
        const value = e.slots[page.id]?.[col];
        return value === undefined || value === null ? (
          <span className={styles.null}>NULL</span>
        ) : (
          String(value)
        );
      },
    })),
  ];

  const rows = world.entries.filter(e => e.deletedAt === null);

  return (
    <TableView<SimEntry>
      name={page.tableName}
      note={`${page.indexedColumns.length} indexed of ${SLOTS_PER_PAGE}`}
      about={
        <>
          The mirror. A filterable field&rsquo;s value is copied out of the JSON
          payload into whichever slot column the reserver gave it, so a filter can
          read a real index instead of walking every document. Teal marks the columns
          that carry one — the rest are storage without an index, which is what most
          of a page is.
        </>
      }
      actions={
        <button
          type="button"
          className={styles.toggle}
          aria-pressed={showAll}
          onClick={() => setShowAll(v => !v)}
        >
          {showAll
            ? `showing all ${SLOTS_PER_PAGE}`
            : `show all ${SLOTS_PER_PAGE} columns`}
        </button>
      }
      rows={rows}
      rowKey={e => e.id}
      columns={columns}
      // Up to 60 columns per row, so an uncapped seeded model is tens of
      // thousands of cells. Empty through the write stage, and defused here
      // rather than left for the stage that fills it.
      maxRows={TABLE_ROW_LIMIT}
      ddl={pageDdl(page.id, page.indexedColumns)}
      empty="No mirrored rows yet. A row appears here when an entry is written to a model with at least one field holding a slot on this page."
    />
  );
}
