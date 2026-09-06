/**
 * `PageProvisioner`, simulated.
 *
 * Adding capacity is one operation with two halves: the `CREATE TABLE` that
 * brings an `entry_slots_page_N` into existence, and the registry transaction
 * that records the page, inserts one `free` slot-inventory row per column, and
 * bumps `stardust_schema_version` — atomically, per ADR 0017 §4.6.
 *
 * Three things about it are load-bearing and easy to blur:
 *
 *   1. **A page carries exactly the columns it indexes** (ADR 0043). It used to
 *      be created with all sixty and index the handful demand asked for, which
 *      meant the inventory advertised fifty-odd `free` rows that no reservation
 *      path could ever claim — capacity on the gauge and nothing behind it.
 *      There is no fixed page size any more: how big a page is was decided by
 *      the planner that asked for it, and is readable only from its own
 *      inventory. The 25/15/10/10 layout survives as the per-family ceiling.
 *   2. **Which columns are indexed is stored nowhere in the registry.** The
 *      engine reads it back out of `information_schema` when it needs it, so
 *      the simulation hangs it off the page rather than off the slot row — see
 *      `SimPage.indexedColumns`. Since 0043 that list is also the page's whole
 *      column set, which is why nothing here needs a second field for it.
 *   3. **Provisioning capacity is not claiming it.** Every row lands `free`
 *      with `field_id = null`. The Watcher provisions and stops; reserving a
 *      slot is somebody else's job, and that separation is the thing section D
 *      exists to show.
 */

import { emit } from './emit';
import { line } from './events';
import { familyOfColumn } from './ddl';
import type { SimPage, SimSlot } from './types';
import { simNow, type SimWorld } from './world';

export interface ProvisionResult {
  world: SimWorld;
  pageId: number;
}

/**
 * `PageProvisioner::provision($filterableSlots)`.
 *
 * `indexedColumns` names the slot columns the new page carries, all of them
 * indexed. **An empty set is not legal**: a page with no columns has no
 * inventory rows, so it adds nothing to the capacity totals, never clears the
 * trigger that asked for it, and would be provisioned again on the next tick.
 * The engine throws on one; here the planner is what guarantees it, by
 * declining to plan a page it would have named no column for.
 */
export function provisionPage(
  world: SimWorld,
  indexedColumns: string[],
  correlationId: string,
): ProvisionResult {
  const now = simNow(world);
  const seq = { ...world.seq };
  const pageId = seq.page++;

  const page: SimPage = {
    id: pageId,
    tableName: `entry_slots_page_${pageId}`,
    provisionedAt: now,
    // The engine stamps the daemon that ran the DDL. Only the Watcher
    // provisions in production, and the playground has no second provisioner.
    provisionedBy: 'watcher',
    indexedColumns: [...indexedColumns],
  };

  const slots: SimSlot[] = indexedColumns.map(slotColumn => ({
    id: seq.slot++,
    pageId,
    slotColumn,
    slotType: familyOfColumn(slotColumn),
    fieldId: null,
    status: 'free',
    sweepCursorId: null,
    tombstonedAt: null,
    sweepGapCount: 0,
    updatedAt: now,
  }));

  const next: SimWorld = {
    ...world,
    pages: [...world.pages, page],
    slots: [...world.slots, ...slots],
    seq,
    // One bump for the whole tuple — the page, its inventory and the version
    // move together or not at all.
    schemaVersion: world.schemaVersion + 1,
    schemaVersionUpdatedAt: now,
  };

  return {
    // `source: 'registry'`, not `'watcher'`. The Watcher owns the *schedule*;
    // the provisioner is a registry collaborator, and the engine logs it as
    // one. Attributing it to the daemon that called it is the natural error
    // and would teach the wrong ownership in the interleaved stream.
    world: emit(next, (nextSeq, tick) => [
      line(
        nextSeq(),
        tick,
        'registry',
        'page_provisioned',
        {
          correlation_id: correlationId,
          page_id: pageId,
          table_name: page.tableName,
          filterable_slots: indexedColumns.join(',') || 'none',
        },
      ),
    ]),
    pageId,
  };
}
