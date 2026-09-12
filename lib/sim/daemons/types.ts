/**
 * What a daemon did on its last poll, so a card can say so.
 *
 * **None of this is a table.** It is a record of the most recent tick, kept on
 * the world because the event log is capped and a daemon that last ran two
 * hundred lines ago would otherwise have nothing to show. The rule the roadmap
 * sets for members of `SimWorld` with no column behind them applies: it must
 * never be rendered as a row in the table inspector, and it is deliberately not
 * part of any `CREATE TABLE` in `ddl.ts`.
 *
 * The one thing here with a real analogue is `worker`: the engine's multi-worker
 * daemons mint a `host:pid:uuid` identity, and `stardust_import_jobs` and
 * `stardust_export_jobs` both persist it in a `worker_identity` column. The
 * sync-queue drain does not — its workers coordinate purely through row locks,
 * so nothing about who claimed what is written down anywhere. These labels are
 * the simulation making that visible, not a column being mirrored.
 */

import type { DaemonName } from '../clock';

/**
 * `TickOutcome`, minus the one state a single-threaded simulation cannot reach.
 *
 * The engine has a fourth, `LOCK_WAIT`: InnoDB refused the chunk over a lock,
 * the bounded retry budget is spent, and the source rolls back and returns
 * rather than letting the exception kill the daemon. It is absent here because
 * nothing in a browser contends for a row, and manufacturing a deadlock to have
 * something to draw would be theatre — an invented failure in the one panel
 * whose claim is that these are the engine's outcomes.
 */
export type TickOutcome = 'work_done' | 'idle' | 'capacity_wait';

/**
 * The Reconciler's work sources, in the engine's round-robin order.
 *
 * The engine runs six and the order is observable in an event stream, so its
 * rule is **new sources append, never insert**. That rule is about *its* list,
 * which this one mirrors — so what matters is the **index**, not the end. The
 * import-job drain is source 2 and belongs to the operations section; when it
 * lands it goes *between* `sync_queue` and `retype_backfill`, not after them.
 */
export type WorkSourceName =
  | 'sync_queue'
  | 'retype_backfill'
  | 'rename_backfill'
  | 'delete_purge'
  | 'model_delete_purge';

export interface WorkerClaim {
  /** `w1` … `w3`. Stands in for the engine's `host:pid:uuid`. */
  worker: string;
  source: WorkSourceName | null;
  outcome: TickOutcome;
  /** Rows or units claimed. Zero when the worker found nothing to claim. */
  claimed: number;
  /** The id range this worker's chunk covered, when it claimed one. */
  firstId: number | null;
  lastId: number | null;
  /**
   * What actually happened to the chunk, when "work done" is not the whole
   * story.
   *
   * The ADR 0007 recovery reports `work_done` — reserving a slot *is* work, and
   * the engine deliberately does not raise a capacity alarm on a successful
   * recovery. But the chunk it claimed rolled back whole and nothing drained,
   * so a chip that read "500 rows" would describe a drain that did not happen.
   */
  note?: 'reserved_and_rolled_back';
}

/**
 * A translation key into `playground.json`'s `daemonRoom.activity` namespace,
 * plus the params it interpolates.
 *
 * A key-and-params pair rather than a rendered string, for the same reason
 * `notify.ts`'s `Say` type is: this file is pure and has no locale to ask, so
 * rendering has to wait for a component that does. `DaemonCard` is the only
 * reader, so it is the only place that calls `useTranslations()` for it.
 */
export interface DaemonActivityMessage {
  key: string;
  params?: Record<string, string | number>;
}

export interface DaemonActivity {
  /** The tick this describes. Compared against `clock.tick` for the pulse. */
  tick: number;
  /** One line for the card. Written by the daemon, not by the component. */
  action: DaemonActivityMessage;
  /** Reconciler only — what each of the three workers claimed. */
  workers?: WorkerClaim[];
}

/**
 * Deliberately `Partial`, not a total `Record`.
 *
 * `persist.ts` restores top-level members wholesale, so a stored world written
 * before a daemon existed would come back missing that key. Typing it partial
 * makes every consumer handle the absence, which is the same hazard `seq` had
 * to solve with a nested merge — solved here at the type level instead.
 */
export type DaemonActivityMap = Partial<Record<DaemonName, DaemonActivity>>;
