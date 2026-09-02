'use client';

import { FAMILY_SLOT_COUNTS, SLOTS_PER_PAGE } from '@/lib/sim/world';
import { readPendingDemand } from '@/lib/sim/capacity';
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

  return (
    <section className={styles.section} id="daemons" aria-labelledby="daemons-title">
      <p className="eyebrow">section d</p>
      <h2 id="daemons-title" className={styles.title}>
        The daemon control room
      </h2>
      <p className="section-lede">
        Four processes on four different poll periods, none of which has ever heard
        of the others. Stop one and watch what stops with it — then promote a field
        with the Watcher down and see the registry and the index disagree, out loud,
        until you let it finish.
      </p>

      <div className={styles.beats}>
        <div className={styles.beat}>
          <h3 className={styles.beatTitle}>Provisioning capacity is not claiming it</h3>
          <p>
            The Watcher adds a page and stops. The field that caused it is still
            unmapped when that tick ends, and a different daemon claims the slot on
            its own schedule. That gap is the design, not a lag — and it is why the
            two of them can be started, stopped and scaled independently.
          </p>
        </div>
        <div className={styles.beat}>
          <h3 className={styles.beatTitle}>Every arrow is a connection to MySQL</h3>
          <p>
            There is no broker, no queue server and no daemon-to-daemon call
            anywhere in this design. The Liberator handing a slot back as{' '}
            <code>free</code> is what stops the Watcher provisioning another page,
            and neither knows the other is running.
          </p>
        </div>
      </div>

      <SharedState />

      <div className={styles.cards}>
        <DaemonCard
          name="watcher"
          kind="singleton"
          role="Provisions indexed pages before capacity runs out — and the moment a field is waiting on a family with nothing claimable, whatever the threshold says."
        >
          <WatcherBody />
        </DaemonCard>

        <DaemonCard
          name="reconciler"
          kind="multi-worker"
          role="Drains work sources round-robin under SKIP LOCKED. Horizontal scale is literally more processes; three of them run here."
        >
          <ReconcilerBody />
        </DaemonCard>

        <DaemonCard
          name="liberator"
          kind="singleton"
          role="Sweeps a tombstoned slot's residue out chunk by chunk, then hands the column back as free so it can be reused."
        >
          <LiberatorBody />
        </DaemonCard>

        <DaemonCard
          name="chronicler"
          kind="multi-worker"
          role="Claims export jobs and streams a CSV or JSON artifact straight to disk, cursor-paginated and never buffered."
        >
          <ChroniclerBody />
        </DaemonCard>
      </div>

      <p className={styles.caveat}>
        <strong>&ldquo;Capacity&rdquo; means an indexed free slot of the field&rsquo;s own
        type family</strong> — not a free slot. A page has sixty columns and indexes
        only the ones demand asked for, so a page with fifty-eight free columns can
        still have nothing a waiting <code>string</code> field may take, and the
        Watcher provisions another one. That is why a promotion on a fresh schema
        almost always takes the slow path: the reservation is deferred, the Watcher
        wakes, and the Reconciler picks it up. The fast path — where the slot is
        reserved inside the transaction <code>promoteFieldToFilterable()</code> itself
        runs and the Watcher never stirs — needs a spare indexed column of that
        family, which in practice means one a demotion has already recycled. Demote a
        field below, let the Liberator finish, then promote another of the same type
        and watch the whole daemon chain not happen.
      </p>

      <div className={styles.split}>
        <FieldIndexReadout />

        <EventLog
          events={world.events}
          // No `sources` filter, deliberately. Section C's log is about what
          // the caller did; this one is the interleaved stream, which is the
          // whole point of the section.
          height="480px"
          title="four daemons, one stream"
          note="NDJSON · stdout"
          empty="Nothing has polled yet. Press run on the clock above, or step it one tick at a time — the daemons emit only when they actually do something, so an idle tick is silent."
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

  const free = world.slots.filter(s => s.status === 'free').length;
  const total = world.slots.length;
  const pct = total === 0 ? 0 : (free / total) * 100;

  return (
    <div className={styles.body}>
      <div className={styles.gaugeTop}>
        <span>free slots</span>
        <strong>
          {free}
          <em> of {total}</em>
        </strong>
      </div>
      <div className={styles.track}>
        <div className={styles.fill} style={{ width: `${pct}%` }} />
      </div>
      <p className={styles.sub}>
        {world.pages.length === 0
          ? 'no page provisioned — bootstrap creates none, and one appears only when something needs it'
          : `${world.pages.length} page${world.pages.length === 1 ? '' : 's'} × ${SLOTS_PER_PAGE} slots`}
      </p>

      <div className={styles.demand}>
        <span className={styles.demandLabel}>pending demand</span>
        {demand.totalWaiters === 0 ? (
          <span className={styles.none}>none — every filterable field holds a slot</span>
        ) : (
          <div className={styles.chips}>
            {demand.families.map(family => (
              <span key={family} className={styles.chip}>
                {FAMILY_LABEL[family]}
                <em>
                  {demand.waiters[family].length} waiting · {FAMILY_SLOT_COUNTS[family]}/page
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

  return (
    <div className={styles.body}>
      <p className={styles.sub}>
        stardust_sync_queue · {world.syncQueue.length} pending
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
                <em className={styles.none}>idle</em>
              ) : (
                busy.map((claim, n) => (
                  <em
                    key={n}
                    className={claim.outcome === 'capacity_wait' ? styles.waiting : undefined}
                  >
                    {claim.source}
                    {claim.outcome === 'capacity_wait'
                      ? ' · capacity_wait'
                      : claim.note === 'reserved_and_rolled_back'
                        ? // The chunk claimed rows and then rolled back whole,
                          // so saying "500 rows" would describe a drain that
                          // did not happen. What it did was reserve a slot.
                          ` · claimed ${claim.claimed}, rolled back, reserved a slot`
                        : claim.firstId === null
                          ? ` · ${claim.claimed}`
                          : ` · ${claim.claimed} rows, ids ${claim.firstId}–${claim.lastId}`}
                  </em>
                ))
              )}
            </div>
          );
        })}
      </div>

      <p className={styles.footnote}>
        Nothing assigns work to a worker. Each claims the next rows nobody else is
        holding — that is all <code>SKIP LOCKED</code> does, and it is the whole
        coordination mechanism. A chunk is 500 rows, so one 600-row seed keeps two
        workers busy and leaves the third with nothing to take.
      </p>
    </div>
  );
}

function LiberatorBody() {
  const { world } = usePlayground();
  const batch = tombstonedBatch(world);

  return (
    <div className={styles.body}>
      {batch.length === 0 ? (
        <p className={styles.none}>
          nothing tombstoned — demote a field below and a column full of values
          nobody will read again appears here
        </p>
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
        The sweep never joins <code>stardust_fields</code>. It keys on the page, the
        column and a cursor, which is what lets it reclaim a slot whose field row is
        already gone.
      </p>
    </div>
  );
}

function ChroniclerBody() {
  const { world } = usePlayground();

  return (
    <div className={styles.body}>
      <p className={styles.sub}>
        stardust_export_jobs · {world.exportJobs.length} rows
      </p>
      <p className={styles.none}>
        no jobs to claim
      </p>
      <p className={styles.footnote}>
        Its poll period and stop button are real and it is genuinely being asked to
        run — there is simply nothing submitting exports yet. A Chronicler with an
        empty job table claims nothing and emits nothing, which is exactly what this
        card is showing. Submitting one is the operations section, alongside bulk
        import and dead-letter replay.
      </p>
    </div>
  );
}
