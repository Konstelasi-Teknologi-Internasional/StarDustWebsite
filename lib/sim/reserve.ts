/**
 * `SlotReserver`, `IndexedSlotPredicate` and `LiveSlotTombstoner`, simulated.
 *
 * This is where a field stops being an intention and acquires a column. Every
 * path that hands a field a slot goes through {@link reserveCore}, which is the
 * ADR 0034 chokepoint: it refuses a non-filterable field outright, so the rule
 * is structurally unbypassable and any entry point added later inherits it
 * without having to remember to.
 *
 * Two statuses come out of here and they are not interchangeable:
 *
 *   - **`assigned`** — the ADR 0007 exhaustion path. A write already happened,
 *     the value is safe in JSON, and the slot is claimed so the queued backfill
 *     can drain into it. There is no promotion ceremony because there is no
 *     half-built index: the very next chunk fills it.
 *   - **`backfilling`** — the promotion lifecycle. Every existing row has to be
 *     copied in before a filter may touch the column, so the slot is live but
 *     deliberately *not* queryable until the final chunk flips it to `ready`.
 *
 * Conflating the two is the natural mistake and it would make the landing
 * page's cold-start caveat wrong.
 */

import { emit } from './emit';
import { detail, line } from './events';
import type { SimSlot, SlotFamily, SlotStatus } from './types';
import {
  FAMILY_OF,
  LIVE_SLOT_STATUSES,
  liveSlotForField,
  simNow,
  type SimWorld,
} from './world';

/**
 * **The single definition of "this slot column carries an index."**
 *
 * The reserver filters its candidates with it and the Watcher's capacity
 * reporter counts usable inventory with it, and they must stay identical: if
 * they drift, the Watcher reports capacity the reserver then refuses, so a page
 * looks healthy while every reservation against it comes back empty. The engine
 * has a source-scanning test enforcing that neither file inlines the rule; here
 * the enforcement is that there is one exported function and no second copy.
 *
 * The engine derives this from `information_schema.STATISTICS` at runtime
 * because it persists the answer nowhere. `SimPage.indexedColumns` is that
 * derivation, modelled as a property of the page for the same reason.
 */
export function isIndexedSlot(world: SimWorld, slot: SimSlot): boolean {
  const page = world.pages.find(p => p.id === slot.pageId);
  return page !== undefined && page.indexedColumns.includes(slot.slotColumn);
}

/** Where a reservation landed relative to the model's existing slots. */
export type SlotAffinity = 'co_located' | 'fallback';

export interface SlotAssignment {
  slotAssignmentId: number;
  pageId: number;
  slotColumn: string;
  slotType: SlotFamily;
  status: SlotStatus;
  affinity: SlotAffinity;
}

export interface ReserveResult {
  world: SimWorld;
  assignment: SlotAssignment | null;
}

/**
 * `NonFilterableFieldSlotException`, as a string.
 *
 * Thrown rather than returned, because it is an invariant violation — "your
 * code asked the registry for something the architecture forbids" — and not the
 * ordinary no-capacity answer, which is `null`. The engine keeps these as two
 * different exceptions one word apart for exactly this reason.
 */
export class NonFilterableFieldSlotError extends Error {}

/**
 * The ADR 0007 exhaustion reservation: `free → assigned`.
 *
 * `requireIndexed` is hardcoded true, and that is not defensive. The slot goes
 * live as `assigned` immediately, so a filter becomes legal at once — landing
 * on an unindexed column would have the engine emit a predicate against no
 * index at all, which ADR 0004 forbids. A deployment whose pages predate
 * index-aware provisioning therefore keeps waiting, correctly.
 */
export function reserveForExhaustion(
  world: SimWorld,
  fieldId: number,
  correlationId: string,
): ReserveResult {
  return reserveCore(world, fieldId, 'assigned', correlationId);
}

/**
 * The promotion reservation: `free → backfilling`.
 *
 * Used by the promotion initiator inside its own registry tuple, and again by
 * the Reconciler's retype work source when that first attempt found no capacity
 * and deferred. Both call sites are unreachable for a non-filterable field, so
 * the guard below is inherited rather than repeated.
 */
export function reserveForBackfill(
  world: SimWorld,
  fieldId: number,
  correlationId: string,
): ReserveResult {
  return reserveCore(world, fieldId, 'backfilling', correlationId);
}

/**
 * The chokepoint every reservation funnels through.
 *
 * Order matters: the field is resolved and the filterability guard fires
 * *before* any candidate search, so a rejected reservation touches nothing.
 */
function reserveCore(
  world: SimWorld,
  fieldId: number,
  status: 'assigned' | 'backfilling',
  correlationId: string,
): ReserveResult {
  const field = world.fields.find(f => f.id === fieldId);
  if (field === undefined || field.deletedAt !== null) {
    return { world, assignment: null };
  }

  // ADR 0034. A non-filterable field holds no slot, ever — the JSON payload is
  // authoritative for it and always will be. This is the guard that makes the
  // model builder's "not indexed yet" marker mean something.
  if (!field.isFilterable) {
    throw new NonFilterableFieldSlotError(
      `SlotReserver: field ${fieldId} is not filterable; only a filterable field may hold a slot.`,
    );
  }

  // "At most one live slot per field" is a partial unique index in the real
  // schema. Here it is a lookup, and it must come before the claim or a second
  // reservation would silently give the field two columns.
  if (liveSlotForField(world, fieldId) !== undefined) {
    return { world, assignment: null };
  }

  const family = FAMILY_OF[field.declaredType];
  const candidate = pickCandidate(world, field.modelId, family);
  if (candidate === null) return { world, assignment: null };

  const now = simNow(world);
  const claimed: SimSlot = {
    ...candidate.slot,
    fieldId,
    status,
    updatedAt: now,
    // Deliberately NOT reset. `sweepGapCount` survives the tombstoned → free
    // reclaim as an operator annotation, and clearing it here would erase the
    // record of a sweep that skipped rows on the column this field is about to
    // start reading.
  };

  const next: SimWorld = {
    ...world,
    slots: world.slots.map(s => (s.id === claimed.id ? claimed : s)),
    schemaVersion: world.schemaVersion + 1,
    schemaVersionUpdatedAt: now,
  };

  const assignment: SlotAssignment = {
    slotAssignmentId: claimed.id,
    pageId: claimed.pageId,
    slotColumn: claimed.slotColumn,
    slotType: claimed.slotType,
    status,
    affinity: candidate.affinity,
  };

  return {
    // `source: 'registry'` — same reasoning as `page_provisioned`. The
    // Reconciler may be the caller, but reserving a slot is a registry act.
    world: emit(next, (nextSeq, tick) => [
      line(
        nextSeq(),
        tick,
        'registry',
        'slot_reserved',
        detail({
          correlation_id: correlationId,
          field_id: fieldId,
          slot_assignment_id: assignment.slotAssignmentId,
          page_id: assignment.pageId,
          slot_column: assignment.slotColumn,
          slot_type: assignment.slotType,
          status,
          affinity: assignment.affinity,
        }),
      ),
    ]),
    assignment,
  };
}

/**
 * Candidate selection, with ADR 0032 model affinity.
 *
 * Prefer a page that already hosts a **live** slot of the same model, so a
 * model's filterable fields cluster and a query joining several of them pays
 * one join instead of four. Fall back to the globally oldest free slot when no
 * affine page has room.
 *
 * **It is a bias, never a constraint.** Affinity must never fail a reservation
 * that would otherwise succeed, or write availability breaks and a field can
 * starve on a technicality. And `requireIndexed` narrows *eligibility*, so it
 * outranks affinity's *ordering*: an unindexed affine page loses to an indexed
 * non-affine one, because a filterable field on an unindexed column is exactly
 * what ADR 0004 forbids.
 *
 * The affine status set includes `backfilling`, which the spread metric's does
 * not. Different questions: spread measures join cost and a `backfilling` slot
 * serves no query, whereas affinity asks where the model is *going* to live.
 */
function pickCandidate(
  world: SimWorld,
  modelId: number,
  family: SlotFamily,
): { slot: SimSlot; affinity: SlotAffinity } | null {
  const modelFieldIds = new Set(
    world.fields.filter(f => f.modelId === modelId).map(f => f.id),
  );

  const affinePageIds = new Set(
    world.slots
      .filter(
        s =>
          s.fieldId !== null &&
          modelFieldIds.has(s.fieldId) &&
          (LIVE_SLOT_STATUSES as readonly string[]).includes(s.status),
      )
      .map(s => s.pageId),
  );

  // Oldest first, which is what an index-ordered `LIMIT 1` walk gives the
  // engine. Slot ids ascend with provisioning order, so id order is page order.
  const eligible = world.slots
    .filter(s => s.status === 'free' && s.slotType === family && isIndexedSlot(world, s))
    .sort((a, b) => a.id - b.id);

  const affine = eligible.find(s => affinePageIds.has(s.pageId));
  if (affine !== undefined) return { slot: affine, affinity: 'co_located' };

  const fallback = eligible[0];
  return fallback === undefined ? null : { slot: fallback, affinity: 'fallback' };
}

/**
 * `LiveSlotTombstoner` — the deliberate two-step.
 *
 * `field_id = NULL` **first**, then `status = 'tombstoned'`. Ostensibly that
 * defends the one-live-slot-per-field unique index, and in the engine it has a
 * second consequence the ordering was not chosen for: nulling the field id
 * releases the foreign key inside the same transaction, which is what lets a
 * field deletion drop its registry row without waiting for a sweep.
 *
 * The orphaned tombstone stays sweepable because the Liberator never joins the
 * field table — it keys on `(page, slot_column)` and a cursor, and nothing else.
 *
 * Returns the slot it tombstoned, or `null` when the field held none. A
 * promotion normally holds none, and that case is not exceptional.
 */
export function tombstoneLiveSlot(
  world: SimWorld,
  fieldId: number,
): { world: SimWorld; slot: SimSlot | null } {
  const live = liveSlotForField(world, fieldId);
  if (live === undefined) return { world, slot: null };

  const now = simNow(world);
  const tombstoned: SimSlot = {
    ...live,
    fieldId: null,
    status: 'tombstoned',
    tombstonedAt: now,
    // **A deliberate divergence from the engine, and the only one in this
    // file.** The sweep starts from the beginning of the page, because a
    // cursor left over from this column's previous life would make the sweep
    // skip every row below it and leave the old field's values sitting in a
    // column the next reserver is about to hand to a filter.
    //
    // The engine does not do this. `LiveSlotTombstoner::tombstone()` writes
    // `field_id`, `status`, `tombstoned_at` and `updated_at` and leaves
    // `sweep_cursor_id` alone; the Liberator's reclaim clears `status` and
    // `field_id` and leaves it alone too; `SlotReserver` never touches it. So
    // `SlotSweeper::sweep()`'s `$cursor = $slot->sweepCursorId ?? 0` reads the
    // *previous* sweep's final cursor on the second tombstone of a recycled
    // column. Found while verifying this stage, reported upstream, and
    // deliberately not reproduced: the playground's headline reclaim demo
    // would otherwise be teaching a bug.
    sweepCursorId: 0,
    updatedAt: now,
  };

  return {
    world: {
      ...world,
      slots: world.slots.map(s => (s.id === tombstoned.id ? tombstoned : s)),
    },
    slot: tombstoned,
  };
}
