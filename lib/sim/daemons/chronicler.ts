/**
 * The Chronicler — multi-worker export drain.
 *
 * **This tick is a no-op, and that is the honest state rather than a stub.**
 *
 * The Chronicler claims rows from `stardust_export_jobs`, paginates
 * `entry_data` with a cursor, and streams a CSV or JSON artifact straight to
 * disk without ever buffering it. There is nothing here for it to claim,
 * because nothing in the playground submits an export yet — that is the
 * operations section, alongside bulk import, the dead-letter replay and
 * compaction. A real Chronicler with an empty job table does exactly this:
 * claims nothing, writes nothing, and emits nothing.
 *
 * So the card is wired like the other three — its poll period is real, its
 * pause toggle works, and it is genuinely being asked to run on schedule. What
 * it reports is that there is no work, which is true. Faking a progress bar
 * against an export nobody submitted would be the one thing the fidelity rules
 * forbid outright: a beautiful panel teaching something untrue.
 *
 * When the operations section lands, this file grows a claim, a page loop and
 * an artifact writer, and nothing about the clock or the card has to change.
 */

import type { SimWorld } from '../world';

export function chroniclerTick(world: SimWorld): SimWorld {
  return world;
}
