/**
 * Appending log lines to the world, and the correlation ids that tie them
 * together.
 *
 * One definition, shared by the write path and all four daemons. It started as
 * a private helper in `write.ts` and moved here the moment a second caller
 * appeared: `seq.event` is a counter on the world, and two functions minting
 * from it independently is precisely the kind of drift the simulation core's
 * one-rule-one-place discipline exists to prevent.
 */

import {
  line,
  type EventFields,
  type EventName,
  type EventSource,
  type SimEvent,
} from './events';
import type { SimWorld } from './world';

/**
 * Append events, minting their `seq` from the world so the reducer stays pure.
 *
 * The callback is handed a `nextSeq()` rather than a starting number because a
 * daemon tick does not know up front how many lines it will emit — the Watcher
 * logs two, four or five depending on what it decided.
 */
export function emit(
  world: SimWorld,
  make: (nextSeq: () => number, tick: number) => SimEvent[],
): SimWorld {
  const seq = { ...world.seq };
  const lines = make(() => seq.event++, world.clock.tick);
  return { ...world, seq, events: [...world.events, ...lines] };
}

/**
 * The single-line convenience over {@link emit}, for the common case.
 *
 * Most emit sites are one line. Spelling that as a callback returning a
 * one-element array is noise, and the noise is what makes people skip the
 * helper and reach for `world.events.push`.
 */
export function emitOne(
  world: SimWorld,
  source: EventSource,
  event: EventName,
  fields: EventFields = {},
  level: SimEvent['level'] = 'info',
): SimWorld {
  return emit(world, (nextSeq, tick) => [
    line(nextSeq(), tick, source, event, fields, level),
  ]);
}

/**
 * A `correlation_id`, derived rather than generated.
 *
 * **The engine emits a UUID v4 here** — one per Watcher poll, one per Reconciler
 * tick, one per Liberator sweep — and every line of that unit carries it, which
 * is how an operator reads four interleaved daemons out of one NDJSON stream.
 * The playground needs the same affordance and cannot have the same value:
 * `Math.random()` inside a reducer is `new Date()` wearing a hat, and React's
 * StrictMode double-invoke would hand the two passes different ids.
 *
 * So this is a pure function of the tick, the source and a per-tick ordinal,
 * rendered short enough to scan in a log panel. It is deliberately *not*
 * UUID-shaped: a sixteen-character hex string that is not a UUID would be a
 * plausible-looking lie in the one panel whose claim is that these are the
 * engine's lines. `w-t12-0` reads as what it is.
 */
export function correlationId(source: EventSource, tick: number, ordinal = 0): string {
  return `${source.charAt(0)}-t${tick}-${ordinal}`;
}
