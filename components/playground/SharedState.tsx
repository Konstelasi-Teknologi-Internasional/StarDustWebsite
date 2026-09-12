'use client';

import { useTranslations } from '@/lib/i18n';
import { usePlayground } from './PlaygroundContext';
import styles from './SharedState.module.css';

/**
 * The only thing any of the four daemons talks to.
 *
 * Every figure here is the length of a real array in a simulated table, and the
 * panel says which table. That matters more than it looks: the daemons never
 * call each other and there is no broker anywhere in the design, so *this* is
 * the entire communication channel between them. The Liberator returning a slot
 * to `free` is what stops the Watcher provisioning another page, and neither
 * has any idea the other exists.
 *
 * The full tables live in section B. This is the four numbers that move.
 */
export default function SharedState() {
  const { world } = usePlayground();
  const t = useTranslations('playground');

  const freeSlots = world.slots.filter(s => s.status === 'free').length;
  const tombstoned = world.slots.filter(s => s.status === 'tombstoned').length;
  const running = world.checkpoints.filter(c => c.status === 'running').length;

  const cells = [
    {
      table: 'stardust_sync_queue',
      value: world.syncQueue.length,
      unit: t(world.syncQueue.length === 1 ? 'sharedState.syncQueueRowOne' : 'sharedState.syncQueueRowMany'),
      note: t('sharedState.syncQueueNote'),
    },
    {
      table: 'stardust_pages',
      value: world.pages.length,
      unit: t(world.pages.length === 1 ? 'sharedState.pageOne' : 'sharedState.pageMany'),
      note: t(freeSlots === 1 ? 'sharedState.freeSlotsAcrossOne' : 'sharedState.freeSlotsAcrossMany', {
        count: freeSlots,
      }),
    },
    {
      table: 'stardust_slot_assignments',
      value: tombstoned,
      unit: t('sharedState.tombstonedUnit'),
      note: t('sharedState.tombstonedNote'),
    },
    {
      table: 'backfill_checkpoints',
      value: running,
      unit: t('sharedState.runningUnit'),
      note: t('sharedState.runningNote'),
    },
    {
      table: 'stardust_reconciler_dlq',
      value: world.dlq.length,
      unit: t('sharedState.quarantinedUnit'),
      note: t('sharedState.quarantinedNote'),
    },
  ];

  return (
    <div className={`panel ${styles.core}`}>
      <div className="panel-head">
        <span>MySQL 8.0.13+</span>
        <span className="tag tag-json">{t('sharedState.groupLabel')}</span>
      </div>

      <div className={styles.grid}>
        {cells.map(cell => (
          <div key={cell.table} className={styles.cell}>
            <span className={styles.table}>{cell.table}</span>
            <strong className={styles.value}>
              {cell.value}
              <em>{cell.unit}</em>
            </strong>
            <span className={styles.note}>{cell.note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
