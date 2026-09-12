'use client';

import { useTranslations } from '@/lib/i18n';
import { readPendingDemand, reportCapacity } from '@/lib/sim/capacity';
import { RECONCILER_WORKERS } from '@/lib/sim/daemons/reconciler';
import { sweepProgress, tombstonedBatch } from '@/lib/sim/daemons/liberator';
import type { SlotFamily } from '@/lib/sim/types';
import EventLog from './EventLog';
import DaemonCard from './DaemonCard';
import FieldIndexReadout from './FieldIndexReadout';
import SharedState from './SharedState';
import { usePlayground } from './PlaygroundContext';
import styles from './DaemonRoom.module.css';

/**
 * Section D — the daemon control room.
 *
 * Everything before this section is a call you made and a row that appeared.
 * This is the part that happens without you, and the reason the playground is a
 * page rather than a sixth demo on the home page: you can stop it.
 *
 * The signature move is the one the landing page can only describe. Stop the
 * Watcher, promote a field, and the system is *honestly incomplete* — the
 * registry says the field is filterable, no slot exists, and a filter is
 * rejected for a reason you caused thirty seconds ago. Start it again and watch
 * the page get provisioned, the slot go `backfilling`, the chunks drain, the
 * flip to `ready`. Nothing about the call changed; the engine caught up
 * underneath it.
 */
export default function DaemonRoom() {
  const { world } = usePlayground();
  const t = useTranslations('playground');

  return (
    <section className={styles.section} id="daemons" aria-labelledby="daemons-title" tabIndex={-1}>
      <p className="eyebrow">{t('daemonRoom.eyebrow')}</p>
      <h2 id="daemons-title" className={styles.title}>
        {t('daemonRoom.heading')}
      </h2>
      <p className="section-lede">{t('daemonRoom.lede')}</p>

      <div className={styles.beats}>
        <div className={styles.beat}>
          <h3 className={styles.beatTitle}>{t('daemonRoom.beat1Title')}</h3>
          <p>{t('daemonRoom.beat1Body')}</p>
        </div>
        <div className={styles.beat}>
          <h3 className={styles.beatTitle}>{t('daemonRoom.beat2Title')}</h3>
          <p>
            {t('daemonRoom.beat2Body1')}
            <code>free</code>
            {t('daemonRoom.beat2Body2')}
          </p>
        </div>
      </div>

      <SharedState />

      <div className={styles.cards}>
        <DaemonCard name="watcher" kind="singleton" role={t('daemonRoom.watcherRole')}>
          <WatcherBody />
        </DaemonCard>

        <DaemonCard name="reconciler" kind="multi-worker" role={t('daemonRoom.reconcilerRole')}>
          <ReconcilerBody />
        </DaemonCard>

        <DaemonCard name="liberator" kind="singleton" role={t('daemonRoom.liberatorRole')}>
          <LiberatorBody />
        </DaemonCard>

        <DaemonCard name="chronicler" kind="multi-worker" role={t('daemonRoom.chroniclerRole')}>
          <ChroniclerBody />
        </DaemonCard>
      </div>

      <p className={styles.caveat}>
        <strong>{t('daemonRoom.caveatBold')}</strong>
        {t('daemonRoom.caveatBody1')}
        <code>promoteFieldToFilterable()</code>
        {t('daemonRoom.caveatBody2')}
      </p>

      <div className={styles.split}>
        <FieldIndexReadout />

        <EventLog
          events={world.events}
          // No `sources` filter, deliberately. Section C's log is about what
          // the caller did; this one is the interleaved stream, which is the
          // whole point of the section.
          height="480px"
          title={t('daemonRoom.title')}
          note={t('daemonRoom.logNote')}
          empty={t('daemonRoom.logEmpty')}
        />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Card bodies — views over the shared state each daemon reads
 * ------------------------------------------------------------------ */

const FAMILY_LABEL: Record<SlotFamily, string> = {
  str: 'string',
  int: 'int',
  num: 'numeric',
  dt: 'datetime',
};

function WatcherBody() {
  const { world } = usePlayground();
  const demand = readPendingDemand(world);
  const snapshot = reportCapacity(world);
  const t = useTranslations('playground');

  const free = world.slots.filter(s => s.status === 'free').length;
  const total = world.slots.length;
  const pct = total === 0 ? 0 : (free / total) * 100;

  return (
    <div className={styles.body}>
      <div className={styles.gaugeTop}>
        <span>{t('daemonRoom.freeSlots')}</span>
        <strong>
          {free}
          <em> {t('daemonRoom.ofTotal', { total })}</em>
        </strong>
      </div>
      <div className={styles.track}>
        <div className={styles.fill} style={{ width: `${pct}%` }} />
      </div>
      <p className={styles.sub}>
        {world.pages.length === 0
          ? t('daemonRoom.noPageProvisioned')
          : t(total === 1 ? 'daemonRoom.slotsAcrossPagesOne' : 'daemonRoom.slotsAcrossPagesMany', {
              total,
              pages: world.pages.length,
            })}
      </p>

      <div className={styles.demand}>
        <span className={styles.demandLabel}>{t('daemonRoom.pendingDemand')}</span>
        {demand.totalWaiters === 0 ? (
          <span className={styles.none}>{t('daemonRoom.noDemand')}</span>
        ) : (
          <div className={styles.chips}>
            {demand.families.map(family => (
              <span key={family} className={styles.chip}>
                {FAMILY_LABEL[family]}
                {/* Indexed *and* free, which is the only kind a waiter can be
                    handed — and a zero here is the starvation trigger, not the
                    threshold, so it provisions whatever the ratio says. */}
                <em>
                  {t('daemonRoom.demandChip', {
                    waiting: demand.waiters[family].length,
                    claimable: snapshot.indexedFree[family],
                  })}
                </em>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ReconcilerBody() {
  const { world } = usePlayground();
  const claims = world.daemonActivity.reconciler?.workers ?? [];
  const t = useTranslations('playground');

  return (
    <div className={styles.body}>
      <p className={styles.sub}>
        {t('daemonRoom.syncQueuePending', { count: world.syncQueue.length })}
      </p>

      <div className={styles.workers}>
        {Array.from({ length: RECONCILER_WORKERS }, (_, i) => {
          const worker = `w${i + 1}`;
          const mine = claims.filter(c => c.worker === worker);
          const busy = mine.filter(c => c.outcome !== 'idle');

          return (
            <div
              key={worker}
              className={`${styles.worker} ${busy.length > 0 ? styles.workerBusy : ''}`}
            >
              <span className={styles.workerName}>{worker}</span>
              {busy.length === 0 ? (
                <em className={styles.none}>{t('daemonRoom.workerIdle')}</em>
              ) : (
                busy.map((claim, n) => (
                  <em
                    key={n}
                    className={claim.outcome === 'capacity_wait' ? styles.waiting : undefined}
                  >
                    {claim.source}
                    {claim.outcome === 'capacity_wait'
                      ? t('daemonRoom.claimCapacityWait')
                      : claim.note === 'reserved_and_rolled_back'
                        ? // The chunk claimed rows and then rolled back whole,
                          // so saying "500 rows" would describe a drain that
                          // did not happen. What it did was reserve a slot.
                          t('daemonRoom.claimRolledBack', { claimed: claim.claimed })
                        : claim.firstId === null
                          ? t('daemonRoom.claimBare', { claimed: claim.claimed })
                          : t('daemonRoom.claimRows', {
                              claimed: claim.claimed,
                              firstId: claim.firstId,
                              // `lastId` is not narrowed by the `firstId`
                              // check above, but a claim with a first id
                              // always has a last one too.
                              lastId: claim.lastId as number,
                            })}
                  </em>
                ))
              )}
            </div>
          );
        })}
      </div>

      <p className={styles.footnote}>
        {t('daemonRoom.reconcilerFootnote1')}
        <code>SKIP LOCKED</code>
        {t('daemonRoom.reconcilerFootnote2')}
      </p>
    </div>
  );
}

function LiberatorBody() {
  const { world } = usePlayground();
  const batch = tombstonedBatch(world);
  const t = useTranslations('playground');

  return (
    <div className={styles.body}>
      {batch.length === 0 ? (
        <p className={styles.none}>{t('daemonRoom.liberatorEmpty')}</p>
      ) : (
        batch.slice(0, 4).map(slot => {
          // Counted off the page table, the same population the sweep walks.
          const { swept, total } = sweepProgress(world, slot.pageId, slot.sweepCursorId ?? 0);
          const pct = total === 0 ? 100 : Math.min(100, (swept / total) * 100);
          return (
            <div key={slot.id} className={styles.sweepRow}>
              <span className={styles.sweepCol}>{slot.slotColumn}</span>
              <div className={styles.track}>
                <div className={styles.sweepFill} style={{ width: `${pct}%` }} />
              </div>
              <span className={styles.sweepCursor}>
                {swept}/{total}
              </span>
            </div>
          );
        })
      )}
      <p className={styles.footnote}>
        {t('daemonRoom.liberatorFootnote1')}
        <code>stardust_fields</code>
        {t('daemonRoom.liberatorFootnote2')}
      </p>
    </div>
  );
}

function ChroniclerBody() {
  const { world } = usePlayground();
  const t = useTranslations('playground');

  return (
    <div className={styles.body}>
      <p className={styles.sub}>
        {t('daemonRoom.exportJobsCount', { count: world.exportJobs.length })}
      </p>
      <p className={styles.none}>{t('daemonRoom.chroniclerEmpty')}</p>
      <p className={styles.footnote}>{t('daemonRoom.chroniclerFootnote')}</p>
    </div>
  );
}
