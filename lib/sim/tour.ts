/**
 * The guided walkthrough: one arc through all six sections, as data.
 *
 * Guided mode is not a second playground. It is a cursor over the sandbox that
 * already exists, dispatching the same actions a visitor dispatches by hand,
 * through the same `reduce()`. Nothing here can express a world the controls
 * cannot — which is the whole reason it is a list of `SimAction` rather than a
 * list of screenshots or a hand-built `SimWorld`.
 *
 * **A step's actions run when the visitor arrives at it, not when they leave.**
 * That inverts what a "next" button usually means, and the rest of the design
 * follows from it. The playground's own premise is that cause and effect sit in
 * different scroll positions: pressing next scrolls to the step's section *and
 * then* commits its actions, so the visitor is already looking at the right
 * part of the page when it changes. The copy is therefore written in the past
 * tense — it says what just happened and why it matters, which is the register
 * `notify.ts` writes in, for the same reason.
 *
 * It also means the panel replaces the milestone feed rather than sitting
 * beside it. The feed's rule is that it only speaks about what is *off* screen;
 * a tour that has just scrolled you to the thing it is describing leaves it
 * nothing true to say, and two fixed docks would compete for one corner.
 * Guided mode silences the cards and keeps the history, so the drawer still has
 * the full record when the tour hands the world over.
 *
 * Every step folds its own ticks. The clock never runs itself here, which makes
 * guided mode behave identically under reduced motion — where the ticker is
 * disabled and **step** is the only thing that advances anything. There is no
 * `nextStepReduced` fork in this file because there is no instruction to press
 * a button that might be disabled: the only button is next.
 *
 * **A tour locks nothing.** Every control on the page stays live while one is
 * running, so a visitor who presses run mid-step moves the world past what the
 * panel is describing. That is allowed, and nothing throws: the assertions here
 * run in `verify:tour`, never in the reducer, on stage 5.5's rule that a throw
 * during render unmounts the tree and takes the exit button with it. The copy is
 * then briefly wrong about a world the visitor changed themselves — which is the
 * same trade the scenario strip's `nextStep` already makes, and the alternative
 * is disabling half the page to protect a sentence.
 *
 * There is deliberately **no back**. The reducer has no undo — a world is a
 * fold, not a stack of diffs — so stepping backwards would mean replaying from
 * `world/reset`, which is what **restart** already is and what it honestly
 * looks like. Pretending otherwise would be the one thing the fidelity rules
 * forbid outright: a control the engine does not have.
 */

import { checkpointFor } from './checkpoints';
import type { FeedSection } from './notify';
import type { SimAction } from './reduce';
import { runningCheckpointForField } from './retype';
import {
  CITY,
  PLACES_MODEL,
  commitPlaces,
  draftPlaces,
  filterCityIs,
  seedPlaces,
  ticks,
} from './script';
import { fieldIndexState, fieldsOf, type SimWorld } from './world';

/**
 * `look` steps commit nothing on purpose — they exist to point at what the
 * previous step produced, which on a page this tall is a real step rather than
 * a wasted click. The distinction is not cosmetic: `verify:tour` requires every
 * `act` step to change the world and every `look` step to leave it alone, which
 * is what catches a step whose actions have quietly become no-ops.
 */
export type TourStepKind = 'act' | 'look';

export interface TourStep {
  /** Stable, kebab-case. React key, and what `verify:tour` prints. */
  id: string;
  /** Scrolled to on arrival. The same six anchors the feed and the strip use. */
  section: FeedSection;
  kind: TourStepKind;
  /** Short enough for a panel heading. */
  title: string;
  /**
   * What just happened, and why it matters. Past tense, sentence case, no
   * braces and no key=value — the event log four sections down is the engine's
   * voice and this is the page's, exactly as with the milestone feed.
   */
  body: string;
  /** Folded by the reducer in one commit, on `scenario/load`'s precedent. */
  actions: SimAction[];
  /**
   * Empty on success; one message per broken expectation.
   *
   * The same defence the scenarios carry, and needed more here: a typed script
   * catches a renamed action at compile time and cannot catch a moved
   * precondition. A poll period changes, the tour still type-checks, still runs
   * to the end, and quietly narrates a promotion that has not happened. Every
   * claim the copy makes out loud is asserted here.
   */
  assert(world: SimWorld): string[];
}

/** The value the hand-written entry carries, and the one the filter looks for. */
const HAND_WRITTEN = 'reykjavik';

/** Ids are dense and 1-based from `world/reset`, so the first write is row 1. */
const HAND_WRITTEN_ID = 1;

/** 601 rows: the batch of 600 plus the one written by hand ahead of it. */
const TOTAL_ROWS = 601;

/** The engine's chunk size, and the reason the seed is 600 rather than 60. */
const CHUNK = 500;

function has(world: SimWorld, event: string): boolean {
  return world.events.some(e => e.event === event);
}

function cityField(world: SimWorld) {
  return world.fields.find(f => f.id === CITY);
}

export const TOUR: readonly TourStep[] = [
  {
    id: 'empty',
    section: 'define',
    kind: 'act',
    title: 'An empty database',
    actions: [{ type: 'world/reset' }],
    body:
      'No models, no fields, no entries, and no page tables. StarDust bootstraps a fixed set of registry tables once and never adds another one — everything you are about to define becomes rows, not DDL.',
    assert(world) {
      const bad: string[] = [];
      if (world.clock.tick !== 0) bad.push(`expected tick 0, got ${world.clock.tick}`);
      if (world.models.length !== 0) bad.push(`expected no model, got ${world.models.length}`);
      if (world.entries.length !== 0) bad.push(`expected no entry, got ${world.entries.length}`);
      if (world.pages.length !== 0) bad.push(`expected no page, got ${world.pages.length}`);
      return bad;
    },
  },
  {
    id: 'draft',
    section: 'define',
    kind: 'act',
    title: 'Three fields, still a draft',
    actions: draftPlaces(),
    body:
      'A model called places, with city, country and population. Nothing is committed yet — this is a form. Every field starts non-filterable, which is what is_filterable NOT NULL DEFAULT FALSE means: a field is JSON-only until somebody asks for more.',
    assert(world) {
      const bad: string[] = [];
      if (world.draft.name !== 'places') {
        bad.push(`expected the draft named places, got '${world.draft.name}'`);
      }
      if (world.draft.fields.length !== 3) {
        bad.push(`expected 3 draft fields, got ${world.draft.fields.length}`);
      }
      if (world.draft.fields.some(f => f.isFilterable)) {
        bad.push('expected every drafted field to be non-filterable');
      }
      // Still a draft: the registry must not have moved.
      if (world.models.length !== 0) {
        bad.push(`expected nothing committed, got ${world.models.length} model(s)`);
      }
      return bad;
    },
  },
  {
    id: 'create',
    section: 'define',
    kind: 'act',
    title: 'Committed',
    actions: commitPlaces(),
    body:
      'One row in stardust_models, three in stardust_fields, and stardust_schema_version bumped exactly once. No page table was created and no slot reserved, because nothing here is filterable. The event log is still empty too — SchemaBuilder writes a PSR-3 message, not an engine event.',
    assert(world) {
      const bad: string[] = [];
      if (world.models.length !== 1) bad.push(`expected 1 model, got ${world.models.length}`);
      const fields = fieldsOf(world, PLACES_MODEL);
      if (fields.length !== 3) bad.push(`expected 3 fields, got ${fields.length}`);
      if (fields[0]?.id !== CITY) {
        bad.push(`expected city to be field ${CITY}, got ${fields[0]?.id ?? 'none'}`);
      }
      if (world.pages.length !== 0) bad.push(`expected no page, got ${world.pages.length}`);
      if (world.slots.length !== 0) bad.push(`expected no slot, got ${world.slots.length}`);
      // The copy says so out loud, and it is the one claim here that a future
      // event-emitting createModel would silently falsify.
      if (world.events.length !== 0) {
        bad.push(`expected an empty event log, got ${world.events.length} line(s)`);
      }
      return bad;
    },
  },
  {
    id: 'tables',
    section: 'tables',
    kind: 'look',
    title: 'What that became in MySQL',
    actions: [],
    body:
      'Your model is rows in two registry tables, and that is the whole of it. There is no entry_slots_page_1 — extension pages are provisioned by the Watcher when something actually needs indexing, never when a model is defined.',
    assert(world) {
      const bad: string[] = [];
      if (world.models.length !== 1) {
        bad.push(`expected the model to still be there, got ${world.models.length}`);
      }
      if (world.pages.length !== 0) bad.push(`expected no page table, got ${world.pages.length}`);
      return bad;
    },
  },
  {
    id: 'write-one',
    section: 'write',
    kind: 'act',
    title: 'One entry, written by hand',
    actions: [
      { type: 'payload/selectModel', modelId: PLACES_MODEL },
      { type: 'payload/setValue', name: 'city', value: HAND_WRITTEN },
      { type: 'payload/setValue', name: 'country', value: 'iceland' },
      { type: 'payload/setValue', name: 'population', value: '139000' },
      { type: 'entry/write' },
    ],
    body:
      'The whole payload went into entry_data.fields as JSON. The splitter looked for a live slot for each of the three fields, found none, and mirrored nothing — and queued nothing either, because no index is falling behind. A write with no index behind it is still a complete, correct write.',
    assert(world) {
      const bad: string[] = [];
      if (world.entries.length !== 1) bad.push(`expected 1 entry, got ${world.entries.length}`);
      const row = world.entries[0];
      if (row?.fields.city !== HAND_WRITTEN) {
        bad.push(`expected the payload to hold city=${HAND_WRITTEN}, got '${String(row?.fields.city)}'`);
      }
      if (row?.id !== HAND_WRITTEN_ID) {
        bad.push(`expected the hand-written row to be id ${HAND_WRITTEN_ID}, got ${row?.id ?? 'none'}`);
      }
      if (world.syncQueue.length !== 0) {
        bad.push(`expected an empty sync queue, got ${world.syncQueue.length} row(s)`);
      }
      if (world.slots.length !== 0) bad.push(`expected no slot, got ${world.slots.length}`);
      return bad;
    },
  },
  {
    id: 'seed',
    section: 'write',
    kind: 'act',
    title: 'Six hundred more',
    actions: seedPlaces(),
    body:
      'Bulk ingest, chunked at 500 rows per transaction — so the log shows two commits rather than six hundred. 601 rows now, every one of them JSON-only, and the sync queue is still empty.',
    assert(world) {
      const bad: string[] = [];
      if (world.entries.length !== TOTAL_ROWS) {
        bad.push(`expected ${TOTAL_ROWS} entries, got ${world.entries.length}`);
      }
      const chunks = world.events.filter(e => e.event === 'bulk_chunk_committed').length;
      // The copy says two commits. One would mean the chunk size moved and the
      // sentence is now a lie; it is also the number the promotion window four
      // steps down depends on.
      if (chunks !== 2) bad.push(`expected 2 bulk chunks, got ${chunks}`);
      if (world.syncQueue.length !== 0) {
        bad.push(`expected an empty sync queue, got ${world.syncQueue.length} row(s)`);
      }
      return bad;
    },
  },
  {
    id: 'refused',
    section: 'query',
    kind: 'act',
    title: 'The filter is refused',
    actions: filterCityIs(HAND_WRITTEN),
    body:
      'field_not_filterable, raised at pre-flight before a single row was read. The value is sitting in every one of those 601 payloads and the engine will not go looking: a filter needs an indexed column, and city has none. This is the honest incompleteness the rest of the tour is about.',
    assert(world) {
      const code = world.queryDraft.lastRun?.rejection?.errorCode;
      return code === 'field_not_filterable'
        ? []
        : [`expected field_not_filterable, got '${code ?? 'no rejection'}'`];
    },
  },
  {
    id: 'promote',
    section: 'daemons',
    kind: 'act',
    title: 'Promote it with the Watcher stopped',
    actions: [
      { type: 'daemon/togglePaused', daemon: 'watcher' },
      { type: 'field/promote', fieldId: CITY },
      ...ticks(3),
    ],
    body:
      'The registry says city is filterable, and city holds no slot. There was no page to reserve from, so the promotion deferred the assignment — and the Reconciler has since tried once and logged capacity_wait. Nothing is broken. The daemon that provisions capacity is stopped, and the system is saying so rather than pretending.',
    assert(world) {
      const bad: string[] = [];
      if (world.clock.tick !== 3) bad.push(`expected tick 3, got ${world.clock.tick}`);
      if (!world.clock.paused.watcher) bad.push('expected the Watcher to be stopped');
      if (world.pages.length !== 0) bad.push(`expected no page, got ${world.pages.length}`);
      if (world.slots.length !== 0) bad.push(`expected no slot, got ${world.slots.length}`);
      if (fieldIndexState(world, CITY) !== 'none') {
        bad.push(`expected city to have no index, got '${fieldIndexState(world, CITY)}'`);
      }
      if (runningCheckpointForField(world, CITY) === undefined) {
        bad.push('expected a running retype checkpoint for city');
      }
      // The copy names this line. Without it the step describes a wait the
      // visitor has no evidence of.
      if (!has(world, 'capacity_wait')) bad.push('expected a capacity_wait line in the log');
      return bad;
    },
  },
  {
    id: 'provision',
    section: 'daemons',
    kind: 'act',
    title: 'Start it, and one tick does three things',
    actions: [{ type: 'daemon/togglePaused', daemon: 'watcher' }, ...ticks(1)],
    body:
      'The Watcher provisioned entry_slots_page_1, and on the same tick the Reconciler reserved i_str_01 and drained the first 500 rows into it. The slot is backfilling: city is neither unindexed nor queryable, and a filter on it is still refused. That state is real, and it is why the two daemons never talk to each other — they meet in MySQL.',
    assert(world) {
      const bad: string[] = [];
      if (world.clock.tick !== 4) bad.push(`expected tick 4, got ${world.clock.tick}`);
      if (world.pages.length !== 1) bad.push(`expected 1 page, got ${world.pages.length}`);
      // The window has to be *visible*, not merely traversed. 'live' here would
      // mean the backfill finished inside one fold and there is nothing to stop
      // inside — which is what a smaller seed would silently produce.
      if (fieldIndexState(world, CITY) !== 'building') {
        bad.push(`expected city mid-backfill, got '${fieldIndexState(world, CITY)}'`);
      }
      const checkpoint = runningCheckpointForField(world, CITY);
      if (checkpoint?.lastProcessedId !== CHUNK) {
        bad.push(`expected a ${CHUNK}-row first chunk, got ${checkpoint?.lastProcessedId ?? 'none'}`);
      }
      const slot = world.slots.find(s => s.fieldId === CITY);
      if (slot?.slotColumn !== 'i_str_01') {
        bad.push(`expected i_str_01 reserved, got '${slot?.slotColumn ?? 'none'}'`);
      }
      return bad;
    },
  },
  {
    id: 'ready',
    section: 'daemons',
    kind: 'act',
    title: 'The remaining rows, and the flip',
    actions: ticks(2),
    body:
      'The final chunk landed, and the slot went to ready in the same transaction that finished it. That is promote_to_ready — and it is the only moment at which the field becomes filterable. There is no half-open state where some rows are searchable and the rest are not.',
    assert(world) {
      const bad: string[] = [];
      if (world.clock.tick !== 6) bad.push(`expected tick 6, got ${world.clock.tick}`);
      if (fieldIndexState(world, CITY) !== 'live') {
        bad.push(`expected city indexed, got '${fieldIndexState(world, CITY)}'`);
      }
      if (!has(world, 'promote_to_ready')) bad.push('expected a promote_to_ready line in the log');
      if (runningCheckpointForField(world, CITY) !== undefined) {
        bad.push('expected the retype checkpoint to be finished');
      }
      return bad;
    },
  },
  {
    id: 'answered',
    section: 'query',
    kind: 'act',
    title: 'The identical filter returns the row',
    actions: [{ type: 'query/run' }],
    body:
      'Same tree, same wire format, same two-query bounded read — and it answers now. The row that comes back is the one you typed by hand at the very start, copied into i_str_01 by the backfill along with the six hundred behind it.',
    assert(world) {
      const run = world.queryDraft.lastRun;
      const bad: string[] = [];
      if (run?.rejection != null) {
        bad.push(`expected no rejection, got '${run.rejection.errorCode}'`);
      }
      if (run?.outcome?.matchedCount !== 1) {
        bad.push(`expected 1 matched row, got ${run?.outcome?.matchedCount ?? 'none'}`);
      }
      // The copy claims it is *their* row. A seeded row matching instead would
      // pass a count assertion and leave the sentence untrue.
      if (run?.outcome?.rows[0]?.id !== HAND_WRITTEN_ID) {
        bad.push(
          `expected the hand-written row ${HAND_WRITTEN_ID}, got ${run?.outcome?.rows[0]?.id ?? 'none'}`,
        );
      }
      return bad;
    },
  },
  {
    id: 'rename',
    section: 'evolve',
    kind: 'act',
    title: 'Rename it under six hundred rows',
    actions: [{ type: 'field/rename', fieldId: CITY, name: 'locality' }, ...ticks(2)],
    body:
      'The registry said locality immediately. But entry_data.fields is keyed by name, so a rename is a rewrite of every payload in the model — and the Reconciler has done one 500-row chunk of it. 500 rows are on the new key, 101 are still on the old one, and stardust_fields.previous_name holds city. That column is the bridge.',
    assert(world) {
      const bad: string[] = [];
      if (world.clock.tick !== 8) bad.push(`expected tick 8, got ${world.clock.tick}`);
      const field = cityField(world);
      if (field?.name !== 'locality') {
        bad.push(`expected the registry to say locality, got '${field?.name ?? 'no field'}'`);
      }
      if (field?.previousName !== 'city') {
        bad.push(`expected previous_name to hold city, got '${field?.previousName ?? 'null'}'`);
      }
      const checkpoint = checkpointFor(world, 'rename', CITY);
      if (checkpoint?.status !== 'running') {
        bad.push(`expected a running rename checkpoint, got '${checkpoint?.status ?? 'none'}'`);
      }
      // **The fixture proof.** The next two steps are both of the form "the API
      // still answers correctly", which passes for free if the rewrite already
      // finished. These two are what make them mean anything.
      const migrated = world.entries.filter(e => 'locality' in e.fields).length;
      const stale = world.entries.filter(e => 'city' in e.fields).length;
      if (migrated !== CHUNK) bad.push(`expected ${CHUNK} rewritten payloads, got ${migrated}`);
      if (stale !== TOTAL_ROWS - CHUNK) {
        bad.push(`expected ${TOTAL_ROWS - CHUNK} payloads still on the old key, got ${stale}`);
      }
      return bad;
    },
  },
  {
    id: 'unknown',
    section: 'query',
    kind: 'act',
    title: 'The old filter fails loudly',
    actions: [{ type: 'query/run' }],
    body:
      'field_unknown — as far as the registry is concerned there is no field called city any more. Writes converge on the new name and filters refuse outright. The asymmetry is deliberate: a rejected filter loses nothing, and a mis-keyed write loses data.',
    assert(world) {
      const code = world.queryDraft.lastRun?.rejection?.errorCode;
      return code === 'field_unknown'
        ? []
        : [`expected field_unknown, got '${code ?? 'no rejection'}'`];
    },
  },
  {
    id: 'bridged',
    section: 'query',
    kind: 'act',
    title: 'A read bridges the window anyway',
    actions: [
      { type: 'query/reset' },
      // Descending, so page one is the newest ids — every one of them *behind*
      // the backfill cursor. Ascending would return the migrated rows and the
      // fallback would never run: a passing check of nothing.
      { type: 'query/setSort', target: 'id', fieldName: null, direction: 'desc' },
      { type: 'query/run' },
    ],
    body:
      'Newest first, so this page is entirely rows the rewrite has not reached — and every one of them comes back on locality, resolved through previous_name. The old key never appears in a result at all, because the projection is over the schema snapshot and the snapshot knows only the current name.',
    assert(world) {
      const bad: string[] = [];
      const rows = world.queryDraft.lastRun?.outcome?.rows ?? [];
      if (rows.length === 0) return ['expected a page of rows, got none'];

      const newest = world.entries.find(e => e.id === rows[0].id);
      if (newest === undefined || !('city' in newest.fields)) {
        bad.push('expected the newest row to still be stored under city');
      }
      if (newest !== undefined && 'locality' in newest.fields) {
        bad.push('expected the newest row NOT to have been rewritten yet');
      }
      const missing = rows.filter(r => r.fields.locality == null).length;
      if (missing > 0) bad.push(`expected every row to resolve locality, got ${missing} null(s)`);
      if (rows.some(r => 'city' in r.fields)) {
        bad.push('expected no row to carry the old key in the result');
      }
      return bad;
    },
  },
  {
    id: 'landed',
    section: 'evolve',
    kind: 'act',
    title: 'The rewrite lands',
    actions: ticks(2),
    body:
      'The last chunk cleared, previous_name went back to null and the checkpoint completed — all in one transaction, because a reader refreshing between them would lose the fallback while un-migrated rows still existed. The bridge exists only while it is needed.',
    assert(world) {
      const bad: string[] = [];
      if (world.clock.tick !== 10) bad.push(`expected tick 10, got ${world.clock.tick}`);
      const field = cityField(world);
      if (field?.previousName !== null) {
        bad.push(`expected previous_name cleared, got '${field?.previousName ?? 'no field'}'`);
      }
      const checkpoint = checkpointFor(world, 'rename', CITY);
      if (checkpoint?.status !== 'completed') {
        bad.push(`expected a completed checkpoint, got '${checkpoint?.status ?? 'none'}'`);
      }
      const stale = world.entries.filter(e => 'city' in e.fields).length;
      if (stale !== 0) bad.push(`expected no payload left on the old key, got ${stale}`);
      const migrated = world.entries.filter(e => 'locality' in e.fields).length;
      if (migrated !== TOTAL_ROWS) bad.push(`expected all ${TOTAL_ROWS} rewritten, got ${migrated}`);
      if (!has(world, 'rename_complete')) bad.push('expected a rename_complete line in the log');
      return bad;
    },
  },
  {
    id: 'done',
    section: 'evolve',
    kind: 'look',
    title: 'That is the whole arc',
    actions: [],
    body:
      'Define, store, write, index, query, evolve. Everything you just watched is still here — the model, the 601 rows, the page, the indexed slot — and every control is unlocked now. Stop a daemon and try to break it.',
    assert(world) {
      // The closing sentence is a set of claims about the world it hands over,
      // so it is checked like any other.
      const bad: string[] = [];
      if (world.models.length !== 1) {
        bad.push(`expected the model to survive, got ${world.models.length}`);
      }
      if (world.entries.length !== TOTAL_ROWS) {
        bad.push(`expected ${TOTAL_ROWS} entries, got ${world.entries.length}`);
      }
      if (world.pages.length !== 1) bad.push(`expected the page to survive, got ${world.pages.length}`);
      if (fieldIndexState(world, CITY) !== 'live') {
        bad.push(`expected the slot still indexed, got '${fieldIndexState(world, CITY)}'`);
      }
      return bad;
    },
  },
];

export const TOUR_LENGTH = TOUR.length;

/**
 * Bounds-checked, because the cursor is component state rather than a member of
 * `SimWorld` — an index that outlives its tour is survivable and must not throw.
 */
export function tourStep(index: number): TourStep | undefined {
  return TOUR[index];
}
