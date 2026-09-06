/**
 * The Liberator — singleton slot reclamation.
 *
 * A demoted field leaves its column full of values nobody will ever read again,
 * and the slot marked `tombstoned` so nothing reserves it. The Liberator is what
 * closes that loop: it nullifies the residue chunk by chunk, then hands the slot
 * back as `free`. Without it every demotion would cost a column permanently, the
 * Watcher would keep provisioning pages to replace capacity that was never
 * actually gone, and the two daemons would never once refer to each other — the
 * whole exchange happens through one row's `status`.
 *
 * Four details are worth keeping straight:
 *
 *   - **The sweep never joins the field table.** It keys on the page, the
 *     column and a cursor, and nothing else. That is what lets it reclaim a
 *     slot whose field row has already been deleted.
 *   - **`sweepGapCount` survives the reclaim.** It counts chunks a sweep
 *     skipped over under contention, and it is an operator annotation about the
 *     *column*, not about the field that used to hold it. Resetting it on
 *     reclaim would erase the record; the engine clears it at the next
 *     tombstone instead (ADR 0045), which `reserve.ts` mirrors.
 *   - **There is no gap path here, and its absence is why this reclaim is
 *     unconditional.** Contention has no meaning in a single-threaded browser
 *     simulation, so every sweep completes cleanly and every completed sweep
 *     reclaims. In the engine those are two statements: a sweep that abandons a
 *     chunk rewinds and stays tombstoned rather than reclaiming (ADR 0046), so
 *     `free` still means verified empty. Do not read this function as evidence
 *     that reaching the final chunk is sufficient to reclaim.
 *   - **An idle tick emits nothing at all.** Not a heartbeat, not a
 *     `poll_complete`. A daemon with no work is silent, which is why its card
 *     has to read as deliberately quiet rather than broken.
 */

import { correlationId, emit } from '../emit';
import { line, type SimEvent } from '../events';
import type { SimEntry, SimSlot } from '../types';
import { simNow, type SimWorld } from '../world';

/** `Config::$liberatorBatchSize` — tombstoned slots picked up per tick. */
export const LIBERATOR_BATCH_SIZE = 50;

/** `Config::$liberatorChunkSize` — rows nullified per chunk transaction. */
export const LIBERATOR_CHUNK_SIZE = 500;

export function liberatorTick(world: SimWorld): SimWorld {
  const batch = tombstonedBatch(world);

  // Idle ticks emit nothing, and record nothing either — a card that said
  // "swept 0 slots" every three ticks would bury the ticks that mattered.
  if (batch.length === 0) return world;

  const corrId = correlationId('liberator', world.clock.tick);

  let next = emit(world, (nextSeq, tick): SimEvent[] => [
    line(
      nextSeq(),
      tick,
      'liberator',
      'sweep_started',
      { correlation_id: corrId, batch_size: batch.length },
    ),
  ]);

  let reclaimed = 0;
  let nullified = 0;

  for (const slot of batch) {
    const swept = sweepOneChunk(next, slot, corrId);
    next = swept.world;
    nullified += swept.rowsNullified;
    if (swept.reclaimed) reclaimed++;
  }

  return {
    ...next,
    daemonActivity: {
      ...next.daemonActivity,
      liberator: {
        tick: world.clock.tick,
        action:
          reclaimed > 0
            ? `nullified ${nullified}, returned ${reclaimed} slot${reclaimed === 1 ? '' : 's'} to free`
            : `nullified ${nullified} across ${batch.length} tombstoned slot${batch.length === 1 ? '' : 's'}`,
      },
    },
  };
}

/**
 * How far one slot's sweep has got, as rows rather than ids.
 *
 * Both numbers are counted the same way {@link sweepOneChunk} counts its
 * population — off the *page table*, not off `entry_data` — or the bar and the
 * sweep disagree about what "done" means.
 *
 * `sweepCursorId` is an entry **id**, not a count, and the two are only equal
 * when every entry has a row on the page. Dividing the cursor by a row count
 * reads as 5000% on a page holding ten rows out of six hundred entries, which
 * is exactly the shape of mistake this helper exists to make impossible.
 */
export function sweepProgress(
  world: SimWorld,
  pageId: number,
  cursor: number,
): { swept: number; total: number } {
  const rows = world.entries.filter(e => e.slots[pageId] !== undefined);
  return { swept: rows.filter(e => e.id <= cursor).length, total: rows.length };
}

/**
 * `TombstonedSlotRepository::loadBatch()`.
 *
 * Oldest tombstone first, then page and column — a stable order with no `FOR
 * UPDATE`, because the singleton guarantee makes claim contention impossible.
 */
export function tombstonedBatch(world: SimWorld): SimSlot[] {
  return world.slots
    .filter(s => s.status === 'tombstoned')
    .sort(
      (a, b) =>
        (a.tombstonedAt ?? '').localeCompare(b.tombstonedAt ?? '') ||
        a.pageId - b.pageId ||
        a.slotColumn.localeCompare(b.slotColumn),
    )
    .slice(0, LIBERATOR_BATCH_SIZE);
}

/**
 * One chunk of one slot's sweep, in one transaction.
 *
 * Select the next `chunkSize` page rows past the cursor, null the column on all
 * of them, advance the cursor. When the select comes back short the page is
 * exhausted, and the *same* transaction flips the slot to `free` and bumps the
 * schema version — the reclaim and the version move together or a reserver
 * could claim a slot whose residue is still there.
 */
function sweepOneChunk(
  world: SimWorld,
  slot: SimSlot,
  corrId: string,
): { world: SimWorld; rowsNullified: number; reclaimed: boolean } {
  const cursor = slot.sweepCursorId ?? 0;

  // **The population is the page table, not `entry_data`.** The engine runs
  // `SELECT entry_id FROM entry_slots_page_N WHERE entry_id > ? LIMIT ?`, and
  // that table has a row only for an entry that has ever had a value written
  // on this page — an entry whose model lives entirely on another page is
  // simply not there.
  //
  // Sweeping every entry instead is the natural shortcut and it is wrong in two
  // visible ways: `rows_nullified` overcounts, and the cursor walks past ids
  // with no row, so a sweep of a page holding two rows reports two full chunks.
  // A NULL that is already NULL does still count — the engine nulls
  // unconditionally — but only for rows that exist.
  const candidates = world.entries
    .filter(e => e.id > cursor && e.slots[slot.pageId] !== undefined)
    .sort((a, b) => a.id - b.id)
    .slice(0, LIBERATOR_CHUNK_SIZE);

  const isFinalChunk = candidates.length < LIBERATOR_CHUNK_SIZE;
  const newCursor = candidates.length > 0 ? candidates[candidates.length - 1].id : cursor;
  const now = simNow(world);

  const swept = new Set(candidates.map(e => e.id));
  const entries: SimEntry[] = world.entries.map(entry => {
    if (!swept.has(entry.id)) return entry;
    const page = entry.slots[slot.pageId];
    if (page === undefined || !(slot.slotColumn in page)) return entry;
    const columns = { ...page };
    delete columns[slot.slotColumn];
    return { ...entry, slots: { ...entry.slots, [slot.pageId]: columns } };
  });

  const next: SimWorld = {
    ...world,
    entries,
    slots: world.slots.map(s =>
      s.id !== slot.id
        ? s
        : {
            ...s,
            sweepCursorId: newCursor,
            updatedAt: now,
            ...(isFinalChunk
              ? { status: 'free' as const, fieldId: null, tombstonedAt: null }
              : {}),
          },
    ),
    ...(isFinalChunk
      ? { schemaVersion: world.schemaVersion + 1, schemaVersionUpdatedAt: now }
      : {}),
  };

  return {
    world: emit(next, (nextSeq, tick): SimEvent[] => {
      const lines = [
        line(
          nextSeq(),
          tick,
          'liberator',
          'sweep_chunk',
          {
            correlation_id: corrId,
            slot_assignment_id: slot.id,
            rows_nullified: candidates.length,
            sweep_cursor_id: newCursor,
          },
        ),
      ];
      if (isFinalChunk) {
        lines.push(
          line(
            nextSeq(),
            tick,
            'liberator',
            'sweep_complete',
            {
              correlation_id: corrId,
              slot_assignment_id: slot.id,
              sweep_cursor_id: newCursor,
            },
          ),
        );
      }
      return lines;
    }),
    rowsNullified: candidates.length,
    reclaimed: isFinalChunk,
  };
}
