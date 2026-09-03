/**
 * The ADR 0020 closed event vocabulary, mirrored.
 *
 * The engine fails its own build if a scanned source directory emits an event
 * name that is not on its allowlist (`EventVocabularyTest`). This file is that
 * discipline, ported: the names are a `const` tuple, {@link EventName} is the
 * union over it, and every log line the simulation emits is typed. An invented
 * name is therefore a `npm run typecheck` failure rather than a
 * plausible-looking string in a log panel.
 *
 * PROVENANCE — this list is every `'event' => '...'` literal emitted from the
 * engine's `src/` as of 2026-09-01. It is a checked-in *mirror*: the engine is
 * a separate repository, so nothing in this repo can prove it still matches.
 * When the engine adds an event, add it here in the same change.
 *
 * One name that is conspicuously absent, and should stay absent: the schema
 * registry's `SchemaBuilder` logs `'schema model defined'` as a plain PSR-3
 * *message*, not as an `'event' =>` key. Defining a model therefore emits
 * nothing into this vocabulary, and the playground's log panel is correctly
 * empty until a daemon runs.
 */

export const EVENT_NAMES = [
  'artifact_oversized',
  'bulk_accepted',
  'bulk_chunk_committed',
  'bulk_chunk_rolled_back',
  'cache_miss',
  'capability_unsupported',
  'capacity_wait',
  'cardinality_sampled',
  'chunk_claimed',
  'chunk_complete',
  'chunk_partial',
  'chunk_skipped',
  'chunk_written',
  'coercion_null',
  'compaction_complete',
  'compaction_planned',
  'deadlock_retry',
  'delete_complete',
  'delete_started',
  'dlq_inserted',
  'entry_deleted',
  'entry_updated',
  'entry_written',
  'exhaustion_fallback',
  'export_accepted',
  'gc_swept',
  'high_spread_model',
  'job_claimed',
  'job_complete',
  'job_failed',
  'lease_lost',
  'lock_contention',
  'lock_wait',
  'log_encode_failed',
  'low_cardinality_index',
  'low_disk',
  'model_delete_complete',
  'model_delete_started',
  'model_renamed',
  'page_provisioned',
  'payload_too_large',
  'poll_complete',
  'poll_started',
  'pre_flight_rejected',
  'promote_to_ready',
  'provision_complete',
  'provision_failed',
  'provision_started',
  'rename_complete',
  'rename_started',
  'retype_started',
  'row_skipped',
  'search_request',
  'slot_reserved',
  'spread_sampled',
  'sweep_chunk',
  'sweep_complete',
  'sweep_gap_flagged',
  'sweep_started',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/**
 * ADR 0020's `source` field. Two sources may share an event name — `cache_miss`
 * is emitted by both `api` and `reconciler` — and this is what disambiguates
 * them, so it is required rather than optional.
 */
export const EVENT_SOURCES = [
  'api',
  'bulk_api',
  'chronicler',
  'export_api',
  'liberator',
  'reconciler',
  'registry',
  'watcher',
] as const;

export type EventSource = (typeof EVENT_SOURCES)[number];

export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * ADR 0020's source-specific fields — the ones each source layers on top of
 * the required four: `page_id`, `rows_processed`, `queue`, and so on.
 *
 * Held structurally rather than as text. That is not how this started: emit
 * sites used to call `detail()` themselves and store only its output, which
 * put *rendering* in the hands of the emitter and left the fields unreadable
 * to anything but a human. `notify.ts` is the second reader, and parsing a
 * rendered string back into pairs would be reaching into another module's
 * output format — lossily, since a value may contain a space.
 */
export type EventFields = Record<string, string | number | boolean | null>;

/**
 * One NDJSON line.
 *
 * `fields` is the structured payload; `detail` is that same payload rendered
 * as the `key=value` text the log panel shows verbatim. Both are stored, and
 * the redundancy is deliberate: {@link line} is the only writer of either, so
 * `detail` is a cache rather than a second source of truth — and keeping it
 * means a snapshot written before `fields` existed still renders exactly as it
 * did, which is what lets this change land without a `SIM_SCHEMA_VERSION`
 * bump. Such a line has no `fields`, so it narrates nothing; correct, since
 * narration is about what just happened rather than about scrolled-past
 * history.
 */
export interface SimEvent {
  /** Monotonic, assigned by the world. Not part of the wire shape. */
  seq: number;
  tick: number;
  level: EventLevel;
  source: EventSource;
  event: EventName;
  /** Absent on lines restored from a snapshot older than this member. */
  fields: EventFields;
  detail: string;
}

/**
 * Construct a log line. Deliberately takes `seq` rather than generating one:
 * a module-level counter would not survive a world reset, and would make the
 * reducers impure under StrictMode's double-invoke.
 *
 * The **only** constructor of a {@link SimEvent}. Building one as an object
 * literal skips `renderDetail()` and produces a line whose `detail` and
 * `fields` can disagree, which is the drift the two-member shape above is
 * only safe without.
 */
export function line(
  seq: number,
  tick: number,
  source: EventSource,
  event: EventName,
  fields: EventFields = {},
  level: EventLevel = 'info',
): SimEvent {
  return { seq, tick, level, source, event, fields, detail: renderDetail(fields) };
}

/**
 * Render ADR 0020's source-specific fields as the `key=value` text
 * {@link SimEvent.detail} holds.
 *
 * Hand-writing those strings at every emit site is a drift surface — the
 * engine's own field names are the thing being mirrored, and a typo in one of
 * them is invisible in a way a bad event *name* is not, because only the name
 * is typechecked. One renderer means the shape is written once.
 *
 * Insertion order is preserved, `true`/`false` render as PHP would log them,
 * and `null` renders as `null` rather than being omitted — an absent field and
 * a null one are different things in a log line.
 *
 * Private on purpose: it is called once, by {@link line}. Exporting it invites
 * an emit site to pre-render its own text again.
 */
function renderDetail(fields: EventFields): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${value === null ? 'null' : String(value)}`)
    .join(' ');
}
