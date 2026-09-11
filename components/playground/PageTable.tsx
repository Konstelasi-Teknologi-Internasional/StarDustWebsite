'use client';

import { useState } from 'react';
import { useTranslations } from '@/lib/i18n';
import { pageDdl } from '@/lib/sim/ddl';
import type { SimEntry, SimPage } from '@/lib/sim/types';
import { slotColumnsInUse, type SimWorld } from '@/lib/sim/world';
import TableView, { TABLE_ROW_LIMIT, type Column } from './TableView';
import styles from './PageTable.module.css';

type Props = {
  page: SimPage;
  world: SimWorld;
};

/**
 * One `entry_slots_page_N` extension table.
 *
 * Its own component because it owns a piece of view state — how many of the
 * page's slot columns to show — and a hook cannot live inside `pages.map()`.
 *
 * Two facts this view exists to keep straight, both easy to blur:
 *
 * 1. **A page carries exactly the columns it indexes** (ADR 0043), so how many
 *    there are is a property of this page rather than a constant: four per
 *    family under the default headroom, more where demand exceeded it. What the
 *    toggle hides is therefore not "the unindexed remainder" — there is none —
 *    but the indexed columns *no field has claimed yet*. Those are the headroom,
 *    and they are what makes the next promotion of that type reserve without
 *    waiting on a daemon.
 * 2. **A column and an index on that column are different things**, even now
 *    that every column here has one. Which columns are indexed was decided when
 *    the page was provisioned, and the engine stores the answer nowhere — it
 *    reads it back out of `information_schema` when it needs it. So it is marked
 *    on the *column header*, as a property of the page, and never as a field on
 *    the slot assignment row.
 */
export default function PageTable({ page, world }: Props) {
  const [showAll, setShowAll] = useState(false);
  const t = useTranslations('playground');

  // Which columns are spoken for. The rule is the core's, not this
  // component's — and it is wider than "live" on purpose, so that a
  // tombstoned column keeps showing its residue until the sweep clears it.
  const occupied = slotColumnsInUse(world, page.id);

  const slotColumns = showAll
    ? page.indexedColumns
    : page.indexedColumns.filter(col => occupied.has(col));

  const columns: Column<SimEntry>[] = [
    { key: 'entry_id', width: '80px', render: e => e.id },
    { key: 'tenant_id', width: '80px', render: e => e.tenantId },
    ...slotColumns.map<Column<SimEntry>>(col => ({
      key: col,
      width: 'minmax(96px, 1fr)',
      // Unconditional, and that is the point: every column a page has is a
      // column it indexes. The marker used to distinguish the handful that
      // carried an index from the fifty-odd that did not.
      tag: (
        <span className={styles.indexed} title={t('pageTable.indexedTooltip')}>
          {' '}
          ●
        </span>
      ),
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
      note={t('pageTable.note', { claimed: occupied.size, total: page.indexedColumns.length })}
      about={t('pageTable.about')}
      actions={
        <button
          type="button"
          className={styles.toggle}
          aria-pressed={showAll}
          onClick={() => setShowAll(v => !v)}
        >
          {showAll
            ? t('pageTable.showingAll', { count: page.indexedColumns.length })
            : t('pageTable.showAll', { count: page.indexedColumns.length })}
        </button>
      }
      rows={rows}
      rowKey={e => e.id}
      columns={columns}
      // A column per slot on the page, so an uncapped seeded model is still
      // thousands of cells. Empty through the write stage, and defused here
      // rather than left for the stage that fills it.
      maxRows={TABLE_ROW_LIMIT}
      ddl={pageDdl(page.id, page.indexedColumns)}
      empty={t('pageTable.empty')}
    />
  );
}
