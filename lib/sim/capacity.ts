/**
 * The Watcher's three collaborators: `CapacityReporter`, `PendingDemandReader`
 * and `ProvisioningPlanner`.
 *
 * All pure, all free of I/O in the engine too — the planner in particular is a
 * `final` class of static methods precisely so the whole policy matrix is
 * testable without a database. Keeping the arithmetic out of the daemon is what
 * makes the daemon a five-line tick.
 */

import { allSlotColumns, familyOfColumn } from './ddl';
import { isIndexedSlot } from './reserve';
import type { SimField, SlotFamily } from './types';
import { FAMILY_OF, liveSlotForField, type SimWorld } from './world';

/** The global free ratio below which the Watcher provisions. `Config`'s default. */
export const CAPACITY_THRESHOLD = 0.2;

export interface CapacitySnapshot {
  totalSlots: number;
  totalFree: number;
  pagesInspected: number;
  /** Indexed free slots, by family. */
  indexedFree: Record<SlotFamily, number>;
  /** Indexed slots in total, by family — free or not. */
  indexedTotal: Record<SlotFamily, number>;
}

function emptyFamilyCounts(): Record<SlotFamily, number> {
  return { str: 0, int: 0, num: 0, dt: 0 };
}

export function globalFreeRatio(snapshot: CapacitySnapshot): number {
  // A deployment with no pages at all has no headroom, and reporting 0/0 as a
  // healthy 1.0 would keep the Watcher asleep through exactly the cold start it
  // exists to resolve. The demand trigger would still fire, but the ratio must
  // not contradict it.
  return snapshot.totalSlots === 0 ? 0 : snapshot.totalFree / snapshot.totalSlots;
}

/** `CapacityReporter::report()`. */
export function reportCapacity(world: SimWorld): CapacitySnapshot {
  const snapshot: CapacitySnapshot = {
    totalSlots: world.slots.length,
    totalFree: 0,
    pagesInspected: world.pages.length,
    indexedFree: emptyFamilyCounts(),
    indexedTotal: emptyFamilyCounts(),
  };

  for (const slot of world.slots) {
    if (slot.status === 'free') snapshot.totalFree++;
    if (!isIndexedSlot(world, slot)) continue;

    snapshot.indexedTotal[slot.slotType]++;
    if (slot.status === 'free') snapshot.indexedFree[slot.slotType]++;
  }

  return snapshot;
}

export interface PendingDemand {
  /** Field ids waiting on a slot, by family. */
  waiters: Record<SlotFamily, number[]>;
  families: SlotFamily[];
  totalWaiters: number;
}

/**
 * `PendingDemandReader::read()` — one predicate, both demand sources.
 *
 * A field is demand when the registry says it should be filterable and it has
 * no live slot. That single condition covers the plain unmapped field *and* the
 * promotion whose reservation was deferred, because the promotion initiator
 * tombstones the old slot in the same transaction that fails to reserve a new
 * one: a deferred waiter provably has no live slot, so it folds in under the
 * correct family with no double-counting and no second query.
 *
 * A deleting field is excluded by `deletedAt`, which is also why the deletion
 * initiator clears `is_filterable` in the same statement — belt and braces the
 * engine needs because this reader carries no model predicate at all.
 */
export function readPendingDemand(world: SimWorld): PendingDemand {
  const waiters: Record<SlotFamily, number[]> = { str: [], int: [], num: [], dt: [] };
  let total = 0;

  for (const field of world.fields) {
    if (!isDemand(world, field)) continue;
    waiters[FAMILY_OF[field.declaredType]].push(field.id);
    total++;
  }

  const families = (Object.keys(waiters) as SlotFamily[]).filter(
    f => waiters[f].length > 0,
  );

  return { waiters, families, totalWaiters: total };
}

function isDemand(world: SimWorld, field: SimField): boolean {
  return (
    field.isFilterable &&
    field.deletedAt === null &&
    liveSlotForField(world, field.id) === undefined
  );
}

export type ProvisioningTrigger = 'none' | 'unsatisfiable_demand' | 'low_capacity';

export interface ProvisioningPlan {
  shouldProvision: boolean;
  trigger: ProvisioningTrigger;
  indexedColumns: string[];
  starvedFamilies: SlotFamily[];
  usableFree: number;
  usableTotal: number;
  usableFreeRatio: number;
}

/**
 * `ProvisioningPlanner::plan()`.
 *
 * Two triggers, OR-composed:
 *
 *   1. **`unsatisfiable_demand`** — a family somebody is waiting on has zero
 *      claimable (indexed **and** free) slots. Fires *regardless of the
 *      threshold*. This is the starvation-freedom guarantee, and without it
 *      satisfiable demand in one family dilutes the global ratio and starves a
 *      waiter in another indefinitely.
 *   2. **`low_capacity`** — the global free ratio fell below the threshold.
 *
 * Starvation takes precedence, because an operator seeing it should not have it
 * reported as routine headroom.
 *
 * ## `usableFreeRatio` is logged and is deliberately NOT a trigger
 *
 * The natural reading — "free slots that cannot satisfy pending demand do not
 * count toward the threshold" — specifies a numerator and no denominator, and
 * both candidate denominators diverge. Against the *global* total, one waiter
 * across ten pages gives a usable ratio near zero, and a new page adds one
 * usable slot but sixty global ones, so the ratio never recovers and the daemon
 * provisions every tick. Against the *usable* total it converges only from an
 * empty base: with existing inventory it walks 0/25 → 1/26 → 2/27 and needs
 * seven pages in seven ticks for one field.
 *
 * So trigger 1 is a set test instead. It fires exactly when a family has
 * nothing claimable and clears the moment the new page carries one indexed free
 * column of that family — one page per starved family-set, no cascade. Do not
 * "fix" the ratio into a trigger.
 *
 * Because the threshold is no longer the only trigger, **setting it to zero no
 * longer means "never provision"**: a starved family still provisions.
 */
export function planProvisioning(
  snapshot: CapacitySnapshot,
  demand: PendingDemand,
  threshold: number = CAPACITY_THRESHOLD,
): ProvisioningPlan {
  let usableFree = 0;
  let usableTotal = 0;
  const starved: SlotFamily[] = [];

  for (const family of demand.families) {
    const indexedFree = snapshot.indexedFree[family];
    usableFree += indexedFree;
    usableTotal += snapshot.indexedTotal[family];
    if (indexedFree === 0) starved.push(family);
  }

  let usableFreeRatio: number;
  if (demand.families.length === 0) {
    // With nobody waiting, every free slot is usable by whatever arrives next,
    // so the honest reading of "usable" is the global figure — counts included.
    // Leaving them at zero emits a self-contradictory line ("0 free of 0 total,
    // ratio 1.0"), and reporting a 0/0 ratio makes an idle deployment provision
    // every tick.
    usableFree = snapshot.totalFree;
    usableTotal = snapshot.totalSlots;
    usableFreeRatio = globalFreeRatio(snapshot);
  } else {
    usableFreeRatio = usableTotal === 0 ? 0 : usableFree / usableTotal;
  }

  const lowCapacity = globalFreeRatio(snapshot) < threshold;

  const trigger: ProvisioningTrigger =
    starved.length > 0 ? 'unsatisfiable_demand' : lowCapacity ? 'low_capacity' : 'none';

  const shouldProvision = trigger !== 'none';

  return {
    shouldProvision,
    trigger,
    indexedColumns: shouldProvision ? indexedColumnsFor(snapshot, demand) : [],
    starvedFamilies: starved,
    usableFree,
    usableTotal,
    usableFreeRatio,
  };
}

/**
 * Which columns the new page should index: enough of each demanded family to
 * cover its shortfall, floored at one and capped at the family's capacity.
 *
 * The floor is not an optimisation. A page provisioned while a field waits on
 * that family must carry an index on at least one of its free columns, and that
 * binds the low-capacity path too, where the shortfall can be zero or negative.
 *
 * With no demand the set is empty and the page is pure headroom. Indexing
 * speculatively is exactly what the design forbids.
 *
 * Capacity comes from the column list rather than a restated 25/15/10/10, so
 * the arithmetic here cannot drift from the DDL.
 */
function indexedColumnsFor(
  snapshot: CapacitySnapshot,
  demand: PendingDemand,
): string[] {
  const columns: string[] = [];

  for (const family of demand.families) {
    const available = allSlotColumns().filter(c => familyOfColumn(c) === family);
    const shortfall = demand.waiters[family].length - snapshot.indexedFree[family];
    const take = Math.max(1, Math.min(shortfall, available.length));
    columns.push(...available.slice(0, take));
  }

  return columns;
}
