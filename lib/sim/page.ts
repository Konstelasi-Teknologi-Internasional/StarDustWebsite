/**
 * `PageProvisioner`, simulated.
 *
 * Adding capacity is one operation with two halves: the `CREATE TABLE` that
 * brings an `entry_slots_page_N` into existence, and the registry transaction
 * that records the page, inserts its full sixty-row slot inventory as `free`,
 * and bumps `stardust_schema_version` — atomically, per ADR 0017 §4.6.
 *
 * Three things about it are load-bearing and easy to blur:
 *
 *   1. **Every page has all sixty slot columns.** What differs between pages is
 *      which of them carry an *index*, and that is decided here, once, from the
 *      demand the caller passed in. Indexing all sixty by default is the cost
 *      this whole design exists to avoid.
 *   2. **Which columns are indexed is stored nowhere in the registry.** The
 *      engine reads it back out of `information_schema` when it needs it, so
 *      the simulation hangs it off the page rather than off the slot row — see
 *      `SimPage.indexedColumns`.
 *   3. **Provisioning capacity is not claiming it.** Every one of the sixty
 *      rows lands `free` with `field_id = null`. The Watcher provisions and
 *      stops; reserving a slot is somebody else's job, and that separation is
 *      the thing section D exists to show.
 */

import { emit } from './emit';
import { detail, line } from './events';
import { allSlotColumns, familyOfColumn } from './ddl';
import type { SimPage, SimSlot } from './types';
import { simNow, type SimWorld } from './world';

export interface ProvisionResult {
  world: SimWorld;
  pageId: number;
}

/**
 * `PageProvisioner::provision($filterableSlots)`.
 *
 * `indexedColumns` names the slot columns the new page should index. An empty
 * set is legal and means pure headroom — the engine's low-capacity trigger can
 * provision a page nobody is waiting on, and indexing speculatively is exactly
 * what ADR 0003 forbids.
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

  const slots: SimSlot[] = allSlotColumns().map(slotColumn => ({
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
        detail({
          correlation_id: correlationId,
          page_id: pageId,
          table_name: page.tableName,
          filterable_slots: indexedColumns.join(',') || 'none',
        }),
      ),
    ]),
    pageId,
  };
}
