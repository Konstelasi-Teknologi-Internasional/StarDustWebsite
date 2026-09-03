/**
 * The Watcher — singleton page provisioner.
 *
 * It does one thing and pointedly does not do the obvious second thing: it adds
 * capacity, and it never claims any. A page appears with sixty free slots and
 * the field that caused it is still unmapped when the tick ends. That gap is
 * not an oversight to be tidied away — it is the separation the whole daemon
 * section exists to show, and collapsing it would turn four independent
 * processes into one pipeline with steps.
 *
 * Everything it decides comes from `capacity.ts`, which is pure and holds the
 * whole policy matrix. This file is the schedule and the logging.
 *
 * ## What is deliberately not here
 *
 * The engine's Watcher also drives two 24-hour advisory samplers — a
 * cardinality scan and a slot-spread scan, sharing one jittered timer so a
 * fleet started in lockstep does not stampede. Neither is simulated. A daily
 * cadence has nothing to show on a clock whose ticks are a second apart, and
 * firing them on some invented shorter period would put a number on screen that
 * means nothing. They are advisories: purely observational, never blocking,
 * never remediating, so leaving them out changes no behaviour anywhere else.
 */

import { correlationId, emit } from '../emit';
import { line, type SimEvent } from '../events';
import { provisionPage } from '../page';
import {
  CAPACITY_THRESHOLD,
  globalFreeRatio,
  planProvisioning,
  readPendingDemand,
  reportCapacity,
} from '../capacity';
import type { SimWorld } from '../world';

export function watcherTick(world: SimWorld): SimWorld {
  const corrId = correlationId('watcher', world.clock.tick);
  const snapshot = reportCapacity(world);
  const demand = readPendingDemand(world);
  const plan = planProvisioning(snapshot, demand, CAPACITY_THRESHOLD);

  let next = emit(world, (nextSeq, tick): SimEvent[] => [
    line(
      nextSeq(),
      tick,
      'watcher',
      'poll_started',
      {
        correlation_id: corrId,
        free_ratio: round4(globalFreeRatio(snapshot)),
        threshold: CAPACITY_THRESHOLD,
        total_slots: snapshot.totalSlots,
        free_slots: snapshot.totalFree,
        pages_inspected: snapshot.pagesInspected,
        usable_free_slots: plan.usableFree,
        usable_total_slots: plan.usableTotal,
        usable_free_ratio: round4(plan.usableFreeRatio),
        pending_demand: demand.families.map(f => `${f}:${demand.waiters[f].length}`).join(',') || 'none',
        pending_waiters: demand.totalWaiters,
        starved_families: plan.starvedFamilies.join(',') || 'none',
      },
    ),
  ]);

  let action = 'no_action';
  let pageId: number | null = null;

  if (plan.shouldProvision) {
    // Logged before the DDL, so the intent survives a crash inside the
    // provisioning window. The engine's ordering, kept.
    next = emit(next, (nextSeq, tick): SimEvent[] => [
      line(
        nextSeq(),
        tick,
        'watcher',
        'provision_started',
        {
          correlation_id: corrId,
          trigger: plan.trigger,
          indexed_columns: plan.indexedColumns.join(',') || 'none',
          pending_waiters: demand.totalWaiters,
        },
      ),
    ]);

    const provisioned = provisionPage(next, plan.indexedColumns, corrId);
    next = provisioned.world;
    pageId = provisioned.pageId;

    next = emit(next, (nextSeq, tick): SimEvent[] => [
      line(
        nextSeq(),
        tick,
        'watcher',
        'provision_complete',
        {
          correlation_id: corrId,
          page_id: provisioned.pageId,
          trigger: plan.trigger,
          indexed_columns: plan.indexedColumns.join(',') || 'none',
        },
      ),
    ]);

    action = 'provisioned';
  }

  next = emit(next, (nextSeq, tick): SimEvent[] => [
    line(
      nextSeq(),
      tick,
      'watcher',
      'poll_complete',
      { correlation_id: corrId, action, trigger: plan.trigger },
    ),
  ]);

  return {
    ...next,
    daemonActivity: {
      ...next.daemonActivity,
      watcher: {
        tick: world.clock.tick,
        action:
          pageId === null
            ? demand.totalWaiters > 0
              ? `${demand.totalWaiters} waiting, capacity available — nothing to provision`
              : 'capacity healthy, no demand'
            : `provisioned page ${pageId} (${plan.trigger}), indexed ${plan.indexedColumns.length}`,
      },
    },
  };
}

/** The engine rounds both ratios to four places before logging them. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
