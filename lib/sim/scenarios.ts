/**
 * Scenario presets — parked worlds, earned rather than staged.
 *
 * A sandbox where every control is unlocked is not the same thing as a sandbox
 * where every *behaviour* is reachable. Three of the things the sections are
 * built around cannot be produced by ordinary play: the promotion window needs
 * a backfill spanning more than one 500-row chunk; the reclaim needs a slot that
 * has been promoted, backfilled, demoted and swept before anything asks for it
 * again; `is_null` mid-backfill needs the Reconciler stopped inside a chunk
 * boundary. Each is a stated "done when" for its section, so a visitor who only
 * ever writes three rows by hand gets a playground where the section's own
 * claim never occurs.
 *
 * The second of those used to be a stronger claim — that a *warm* reservation
 * was unreachable at all, because the Watcher indexed only as many columns as
 * there were waiters and a fresh page therefore never had a spare. Index
 * headroom retired that: a page now carries four columns of every family, so
 * three of them are spare the moment it exists and the second promotion of a
 * type is warm without any help. What is still unreachable by ordinary play is
 * the *round trip* — and that is what this scenario now parks in front of.
 *
 * What is missing is not data — the entry writer already seeds 600 rows — but
 * *history*. Every one of those three comes from an ordering, or from a prior
 * lifecycle, rather than from a row count.
 *
 * Hence: a list of the same actions a human dispatches, folded through the same
 * `reduce()`. Never a hand-built `SimWorld`. A literal world would be a fifth
 * mirror of the engine that nothing checks, and it could express states the
 * reducer cannot reach — a `ready` slot with no backfill behind it, a
 * checkpoint over an empty queue. Replaying actions also produces the right
 * event log for free, and the log is the receipt that the state was earned.
 *
 * Two further rules, and both are load-bearing:
 *
 * 1. **Park before the payoff.** A scenario that runs to the end is a video of
 *    the playground. The visitor's first click is the interesting one.
 * 2. **Fold your own ticks.** `clock/tick` is dispatched from the script, never
 *    awaited from the ticker — which is disabled under reduced motion, so a
 *    scenario that advanced by letting the clock run would be dead for exactly
 *    the visitors most in need of being handed a parked world.
 */

import { checkpointFor } from './checkpoints';
import type { MilestoneKind } from './notify';
import { isIndexedSlot } from './reserve';
import { runningCheckpointForField } from './retype';
import type { SimAction } from './reduce';
import { fieldIndexState, fieldsOf, type SimWorld } from './world';

export type ScenarioId = 'promotion-window' | 'warm-path' | 'half-migrated';

export interface Scenario {
  id: ScenarioId;
  /** Short enough for a button. */
  title: string;
  /** One line under the title: what it is. */
  blurb: string;
  /** What the parked world *is*, once loaded. */
  parked: string;
  /** The first thing to click. */
  nextStep: string;
  /** The same, when the clock cannot run itself. */
  nextStepReduced: string;
  /** The section the payoff happens in, and what to call it in a link. */
  anchor: string;
  anchorLabel: string;
  /**
   * Folded through `reduce()` in order. Always starts with `world/reset`, so a
   * scenario ignores whatever world it was loaded over — which is the whole
   * reason the picker warns before replacing a populated one.
   */
  actions: SimAction[];
  /**
   * Empty on success; one message per broken expectation.
   *
   * A typed script catches a renamed action at compile time and cannot catch a
   * moved precondition: a poll period changes, the script still type-checks,
   * still runs to completion, and quietly parks somewhere else. These are the
   * defence, which is why the tick count is asserted rather than assumed.
   */
  assertParked(world: SimWorld): string[];
  /**
   * The clicks the park exists to set up, and what must happen at each.
   *
   * Parking correctly is not the same as promising correctly: a scenario can
   * park exactly where it says and still have a `nextStep` that no longer
   * describes what happens next. These are the prose held to account — the
   * strip claims a filter is refused, then accepted; the warm path claims a
   * reservation with no Watcher tick in between; both are checked rather than
   * asserted.
   *
   * Staged rather than one list because the interesting property is
   * *mid-sequence*: that the promotion window is visible at all, not merely
   * that it closes. Folded by `scripts/verify-scenarios.ts`, which is also why
   * this is data rather than a function — `scenarios.ts` may not import
   * `reduce()` at runtime, or the module cycle becomes a real one.
   */
  payoff: PayoffStage[];
}

export interface PayoffStage {
  label: string;
  actions: SimAction[];
  assert(world: SimWorld): string[];
  /**
   * The milestones this stage must put in front of a visitor.
   *
   * A third claim, distinct from the two above. Parking correctly is not
   * promising correctly, and *promising* correctly is not *narrating*
   * correctly: a stage can fire exactly as asserted while the feed says
   * nothing at all, which on a five-section page is indistinguishable from
   * nothing having happened. That failure is invisible to every other check
   * here, because every other check reads the world rather than what the
   * visitor was told about it.
   *
   * Checked as a subset, not an equality — a stage that additionally narrates
   * something true is not a regression, and pinning the exact set would make
   * every new entry in `notify.ts`'s map break unrelated scenarios.
   */
  narrates?: MilestoneKind[];
}

/** The filter both scenarios use: one leaf, one seeded value, at the root. */
function filterCityIs(value: string): SimAction[] {
  return [
    { type: 'query/selectModel', modelId: 1 },
    { type: 'query/addCondition', fieldName: 'city' },
    // `addCondition` puts a single leaf at the root, so the path is empty.
    // It also defaults the value to '', which matches nothing — a filter left
    // that way would report zero rows and look like a broken payoff.
    { type: 'query/setValue', path: [], text: value },
    { type: 'query/run' },
  ];
}

/** `clock/tick` × n. */
function ticks(n: number): SimAction[] {
  return Array.from({ length: n }, (): SimAction => ({ type: 'clock/tick' }));
}

/**
 * The shared prefix: a three-field model and 600 rows, nothing indexed.
 *
 * Both scenarios open with this, so the second is the first plus a
 * continuation rather than a copy of it.
 *
 * Every field is created non-filterable — which is `draft/addField`'s only
 * behaviour, matching `stardust_fields.is_filterable NOT NULL DEFAULT FALSE` —
 * so all 600 writes land in `jsonOnlyFields` and the sync queue stays empty.
 * That matters: a filterable field with no slot would route the writes into the
 * ADR 0007 exhaustion path, where the Reconciler reserves an `assigned` slot
 * and the promotion window never happens at all.
 *
 * `population` is last on purpose. `seedPayloads` drops the *last* field on
 * every seventh row, so putting either string field there would leave ~86 rows
 * without the value the scenario is about.
 */
function placesModel(): SimAction[] {
  return [
    { type: 'world/reset' },
    { type: 'draft/setName', name: 'places' },
    // Draft keys are `d1`, `d2`, … — `nextKey` starts at 1 and a reset world
    // has an empty draft, so they are deterministic here.
    { type: 'draft/addField', declaredType: 'string' },
    { type: 'draft/patchField', key: 'd1', patch: { name: 'city' } },
    { type: 'draft/addField', declaredType: 'string' },
    { type: 'draft/patchField', key: 'd2', patch: { name: 'country' } },
    { type: 'draft/addField', declaredType: 'int' },
    { type: 'draft/patchField', key: 'd3', patch: { name: 'population' } },
    // Fields commit in draft order, so city = 1, country = 2, population = 3.
    { type: 'registry/createModel' },
    // `entry/seed` reads `payloadDraft.modelId` rather than taking one.
    { type: 'payload/selectModel', modelId: 1 },
    // 600, which straddles the 500-row chunk. At 60 the whole backfill would
    // finish inside a single fold and there would be no window to stop in.
    { type: 'entry/seed' },
  ];
}

const CITY = 1;
const COUNTRY = 2;

const PROMOTION_WINDOW: Scenario = {
  id: 'promotion-window',
  title: 'The promotion window',
  blurb: 'A field marked filterable with the Watcher stopped, and 600 rows waiting behind it.',
  parked:
    '600 rows written · city is filterable but holds no slot · the Watcher is stopped · a filter on city is refused at pre-flight. The Reconciler has already tried once and logged capacity_wait, which is why nothing is moving.',
  nextStep:
    'Start the Watcher, then press run. The next tick provisions the page, reserves the slot and drains the first 500 rows; two ticks later the last 100 land and the slot flips to ready.',
  nextStepReduced:
    'Start the Watcher, then press step. The next tick provisions the page, reserves the slot and drains the first 500 rows; two steps later the last 100 land and the slot flips to ready.',
  anchor: '#daemons',
  anchorLabel: 'the daemon control room',
  actions: [
    ...placesModel(),
    { type: 'daemon/togglePaused', daemon: 'watcher' },
    // No page exists, so there is nothing to reserve from and the initiator
    // defers the assignment. The engine does not provision eagerly to make
    // room for itself — that is the Watcher's job, and it is stopped.
    { type: 'field/promote', fieldId: CITY },
    // Park at tick 3 rather than 0. The Reconciler is due at 2, fails to
    // reserve and logs `capacity_wait`, so the parked world explains itself —
    // and the payoff then lands on the very next tick instead of the fourth.
    ...ticks(3),
  ],
  assertParked(world) {
    const bad: string[] = [];
    const say = (ok: boolean, msg: string) => {
      if (!ok) bad.push(msg);
    };

    say(world.clock.tick === 3, `expected to park at tick 3, got ${world.clock.tick}`);
    say(world.clock.paused.watcher, 'expected the Watcher to be stopped');
    say(world.models.length === 1, `expected 1 model, got ${world.models.length}`);
    say(world.entries.length === 600, `expected 600 entries, got ${world.entries.length}`);
    say(world.pages.length === 0, `expected no page, got ${world.pages.length}`);
    say(world.slots.length === 0, `expected no slot rows, got ${world.slots.length}`);
    say(
      world.syncQueue.length === 0,
      `expected an empty sync queue, got ${world.syncQueue.length} rows`,
    );
    say(
      fieldIndexState(world, CITY) === 'none',
      `expected city to have no index, got '${fieldIndexState(world, CITY)}'`,
    );
    say(
      runningCheckpointForField(world, CITY) !== undefined,
      'expected a running retype checkpoint for city',
    );
    // The park claims to explain itself. If this line is gone the scenario
    // still "works" and the strip is telling the visitor something untrue.
    say(
      world.events.some(e => e.event === 'capacity_wait'),
      'expected a capacity_wait line in the log',
    );
    return bad;
  },
  payoff: [
    {
      label: 'a filter on city is refused at pre-flight',
      actions: filterCityIs('aurora-1'),
      // The refusal is the setup, and the visitor has to be told it happened
      // — they may well have run it from four sections away.
      narrates: ['filter-refused'],
      assert(world) {
        const run = world.queryDraft.lastRun;
        const code = run?.rejection?.errorCode;
        return code === 'field_not_filterable'
          ? []
          : [`expected field_not_filterable, got '${code ?? 'no rejection'}'`];
      },
    },
    {
      label: 'starting the Watcher provisions, reserves and drains one chunk',
      actions: [{ type: 'daemon/togglePaused', daemon: 'watcher' }, { type: 'clock/tick' }],
      // Two things a visitor cannot see at once: a page appeared in section B
      // and a column was claimed on it. Deliberately *not* `lifecycle-started`
      // — `city` was promoted back in the parked prefix, with the Watcher
      // already stopped, so that milestone is three ticks in the past by the
      // time this stage runs and the strip is what explains it. Asserting it
      // here is the mistake this list is good at catching.
      narrates: ['page-provisioned', 'slot-reserved'],
      assert(world) {
        const bad: string[] = [];
        // The whole point of the 600-row seed: the window has to be *visible*,
        // not merely traversed. If this reads 'live' the backfill finished
        // inside one fold and there is nothing for a visitor to stop inside.
        if (fieldIndexState(world, CITY) !== 'building') {
          bad.push(`expected city mid-backfill, got '${fieldIndexState(world, CITY)}'`);
        }
        if (world.pages.length !== 1) bad.push(`expected 1 page, got ${world.pages.length}`);
        const checkpoint = runningCheckpointForField(world, CITY);
        if (checkpoint?.lastProcessedId !== 500) {
          bad.push(`expected a 500-row first chunk, got ${checkpoint?.lastProcessedId ?? 'none'}`);
        }
        return bad;
      },
    },
    {
      label: 'two more ticks finish it and the slot flips to ready',
      actions: ticks(2),
      // The headline of the whole page. If nothing else here narrates, this
      // must.
      narrates: ['field-indexed'],
      assert(world) {
        const bad: string[] = [];
        if (fieldIndexState(world, CITY) !== 'live') {
          bad.push(`expected city indexed, got '${fieldIndexState(world, CITY)}'`);
        }
        if (!world.events.some(e => e.event === 'promote_to_ready')) {
          bad.push('expected a promote_to_ready line in the log');
        }
        return bad;
      },
    },
    {
      label: 'the identical filter now returns its row',
      actions: [{ type: 'query/run' }],
      assert(world) {
        const run = world.queryDraft.lastRun;
        const bad: string[] = [];
        if (run?.rejection != null) {
          bad.push(`expected no rejection, got '${run.rejection.errorCode}'`);
        }
        if (run?.outcome?.matchedCount !== 1) {
          bad.push(`expected 1 matched row, got ${run?.outcome?.matchedCount ?? 'none'}`);
        }
        return bad;
      },
    },
  ],
};

const WARM_PATH: Scenario = {
  id: 'warm-path',
  title: 'The warm path',
  blurb: 'A swept column goes back in the pool, and is the one the next promotion takes.',
  parked:
    'city was promoted, backfilled and then demoted · the Liberator has swept its slot back to free · i_str_01 is free, still indexed, and carries no residue · country is not filterable yet. The page also holds i_str_02–i_str_04, indexed since it was provisioned and never claimed by anything: that is the headroom, and it is why a second promotion is warm even without a demotion. What only a full round trip produces is a column that has been used and handed back.',
  nextStep:
    'Promote country in the daemon control room. It reserves inside the promoting transaction with no Watcher tick in between — and it takes i_str_01, the recycled column, rather than untouched headroom, because the reserver walks the free list oldest first. Then press run to drain the backfill.',
  nextStepReduced:
    'Promote country in the daemon control room. It reserves inside the promoting transaction with no Watcher tick in between — and it takes i_str_01, the recycled column, rather than untouched headroom, because the reserver walks the free list oldest first. Then press step to drain the backfill.',
  anchor: '#daemons',
  anchorLabel: 'the daemon control room',
  actions: [
    ...placesModel(),
    // Nothing is paused: this scenario needs the cold start to complete so
    // that there is an indexed column to recycle.
    { type: 'field/promote', fieldId: CITY },
    // 4: the Watcher provisions and the Reconciler reserves and drains chunk 1
    // in the same fold. 6: chunk 2 is final, the slot flips to ready.
    ...ticks(6),
    // Registry-only, and the one thing in the playground that makes a
    // tombstone — without it the Liberator has no work and no column is ever
    // recycled.
    { type: 'field/demote', fieldId: CITY },
    // 9: the sweep nullifies 500 rows. 12: the last 100, final chunk, and the
    // slot returns to `free` with the page's `indexedColumns` untouched — which
    // is the whole point: a reclaimed column is indexed capacity again, not a
    // column that has to be provisioned for a second time.
    ...ticks(6),
  ],
  assertParked(world) {
    const bad: string[] = [];
    const say = (ok: boolean, msg: string) => {
      if (!ok) bad.push(msg);
    };

    say(world.clock.tick === 12, `expected to park at tick 12, got ${world.clock.tick}`);
    say(world.pages.length === 1, `expected 1 page, got ${world.pages.length}`);
    say(
      world.pages[0]?.indexedColumns.includes('i_str_01') ?? false,
      'expected i_str_01 to still be indexed on the page',
    );

    // Four, not one: i_str_01 came back from the sweep, and i_str_02-04 have
    // been free and indexed since the page was provisioned. The scenario's
    // claim is about *which* of the four the next promotion takes, so the
    // interesting assertion is that the recycled one is among them and holds
    // nothing — a count alone would pass with the sweep half done.
    const freeIndexedStr = world.slots.filter(
      s => s.status === 'free' && s.slotType === 'str' && isIndexedSlot(world, s),
    );
    say(
      freeIndexedStr.length === 4,
      `expected 4 free indexed string slots, got ${freeIndexedStr.length}`,
    );

    const recycled = freeIndexedStr.find(s => s.slotColumn === 'i_str_01');
    say(recycled !== undefined, 'expected the swept i_str_01 to be free and indexed');
    say(
      recycled?.fieldId === null,
      'expected the recycled slot to hold no field id',
    );
    say(
      world.entries.every(e => e.slots[1]?.i_str_01 == null),
      'expected the sweep to have nullified every mirrored city value',
    );

    const notFree = world.slots.filter(s => s.status !== 'free');
    say(
      notFree.length === 0,
      `expected every slot back to free, got ${notFree.map(s => s.status).join(', ')}`,
    );

    const fields = fieldsOf(world, 1);
    say(
      fields.find(f => f.name === 'city')?.isFilterable === false,
      'expected city to be non-filterable after the demotion',
    );
    say(
      fields.find(f => f.name === 'country')?.isFilterable === false,
      'expected country to still be non-filterable',
    );
    say(
      fieldIndexState(world, COUNTRY) === 'none',
      `expected country to have no index, got '${fieldIndexState(world, COUNTRY)}'`,
    );
    say(
      runningCheckpointForField(world, CITY) === undefined,
      'expected no running checkpoint left over from the backfill',
    );
    return bad;
  },
  payoff: [
    {
      label: 'promoting country takes the recycled column, not untouched headroom',
      actions: [{ type: 'field/promote', fieldId: COUNTRY }],
      // The warm path's whole claim is that this happens inside the promoting
      // transaction. The slot-reserved card is the visible half of that, and
      // its absence would mean the reservation was deferred after all.
      narrates: ['slot-reserved', 'lifecycle-started'],
      assert(world) {
        const bad: string[] = [];

        // The claim is that no daemon ran. Nothing advanced the clock, so
        // nothing *could* have — this is the assertion that would catch a
        // future change making promotion depend on the Watcher again.
        if (world.clock.tick !== 12) {
          bad.push(`expected the clock not to move, got tick ${world.clock.tick}`);
        }
        if (world.lastLifecycle?.error != null) {
          bad.push(`expected the promotion to succeed, got '${world.lastLifecycle.error}'`);
        }
        if (fieldIndexState(world, COUNTRY) !== 'building') {
          bad.push(`expected country mid-backfill, got '${fieldIndexState(world, COUNTRY)}'`);
        }

        // It must be the *recycled* slot. Three untouched headroom columns of
        // the same family were free alongside it, so this is a claim about the
        // reserver's oldest-first walk and not merely about capacity existing.
        const slot = world.slots.find(s => s.fieldId === COUNTRY);
        if (slot?.slotColumn !== 'i_str_01') {
          bad.push(`expected the recycled i_str_01, got '${slot?.slotColumn ?? 'none'}'`);
        }
        if (world.pages.length !== 1) {
          bad.push(`expected no new page, got ${world.pages.length}`);
        }

        // The engine's own word for "reserved inside the promoting
        // transaction" rather than handed to the Watcher.
        // Read off the structured payload rather than out of the rendered
        // line. A substring match on `detail` would also have passed for a
        // field named `deferred_assignment=false-ish`, and more to the point
        // it asserted on the log's *formatting* rather than on what was
        // logged.
        const started = world.events.filter(e => e.event === 'retype_started').slice(-1)[0];
        if (started?.fields.deferred_assignment !== false) {
          bad.push('expected retype_started to report deferred_assignment=false');
        }
        return bad;
      },
    },
  ],
};

/**
 * The rename window, stopped inside it.
 *
 * The one scenario here whose first click is not **run**. A rename touches no
 * slot, so there is no daemon to start and no capacity to wait for: the world is
 * already in the interesting state the instant it loads, and what the visitor
 * does first is *read* across it. That is also why `nextStepReduced` is the same
 * sentence as `nextStep` — reduced motion disables the ticker, and this payoff
 * asks for no ticks at all until its third stage.
 *
 * Nothing is paused except the Reconciler, deliberately. The Watcher and
 * Liberator run throughout and do nothing, and `assertParked` checks that they
 * did nothing — zero pages, zero slots — which is a stronger statement of "a
 * rename touches no slot" than pausing them would have been.
 */
const HALF_MIGRATED: Scenario = {
  id: 'half-migrated',
  title: 'The half-migrated world',
  blurb: 'A field renamed under 600 rows, with the Reconciler stopped in the middle of the rewrite.',
  parked:
    'city was renamed to locality · the registry already says locality · 500 payloads have been rewritten and 100 are still stored under city · stardust_fields.previous_name holds the old name · the Reconciler is stopped. No page and no slot exist, because a rename touches neither.',
  nextStep:
    'Run a read in the query builder. Every row comes back on locality — including the hundred still stored as city, which the read resolves through the fallback. Then resume the Reconciler and press run to finish the rewrite.',
  // Identical on purpose: the first two stages need no tick, so there is no
  // disabled button to steer anyone away from.
  nextStepReduced:
    'Run a read in the query builder. Every row comes back on locality — including the hundred still stored as city, which the read resolves through the fallback. Then resume the Reconciler and press step to finish the rewrite.',
  anchor: '#query',
  anchorLabel: 'the query builder',
  actions: [
    ...placesModel(),
    // Synchronous: the registry flips and the checkpoint opens before this
    // action returns. Every one of the 600 payloads is still keyed `city`.
    { type: 'field/rename', fieldId: CITY, name: 'locality' },
    // The Reconciler is due at tick 2 and rewrites exactly one 500-row chunk.
    ...ticks(2),
    // Stopped *after* that chunk, which is what leaves the world half-migrated.
    // Two ticks earlier and there would be no window; two later and it would
    // have closed.
    { type: 'daemon/togglePaused', daemon: 'reconciler' },
  ],
  assertParked(world) {
    const bad: string[] = [];
    const say = (ok: boolean, msg: string) => {
      if (!ok) bad.push(msg);
    };

    say(world.clock.tick === 2, `expected to park at tick 2, got ${world.clock.tick}`);
    say(world.clock.paused.reconciler, 'expected the Reconciler to be stopped');
    say(world.entries.length === 600, `expected 600 entries, got ${world.entries.length}`);

    // A rename touches no slot. Neither of these is incidental: if a page ever
    // appears here, something in the rename path has started asking for
    // capacity it must never need.
    say(world.pages.length === 0, `expected no page, got ${world.pages.length}`);
    say(world.slots.length === 0, `expected no slot rows, got ${world.slots.length}`);

    const field = world.fields.find(f => f.id === CITY);
    say(field?.name === 'locality', `expected the registry to say locality, got '${field?.name}'`);
    say(
      field?.previousName === 'city',
      `expected previous_name to hold city, got '${field?.previousName ?? 'null'}'`,
    );

    const checkpoint = checkpointFor(world, 'rename', CITY);
    say(checkpoint?.status === 'running', `expected a running rename checkpoint, got '${checkpoint?.status ?? 'none'}'`);
    say(
      checkpoint?.lastProcessedId === 500,
      `expected the cursor at 500, got ${checkpoint?.lastProcessedId ?? 'none'}`,
    );

    // **The fixture proof, and it is not optional.** Every other assertion in
    // this scenario and its payoff is of the form "the API still answers
    // correctly", which passes for free if the rewrite already finished. These
    // two are what make the rest mean anything.
    const migrated = world.entries.filter(e => 'locality' in e.fields).length;
    const stale = world.entries.filter(e => 'city' in e.fields).length;
    say(migrated === 500, `expected 500 rewritten payloads, got ${migrated}`);
    say(stale === 100, `expected 100 payloads still on the old key, got ${stale}`);

    return bad;
  },
  payoff: [
    {
      label: 'a read across the window returns every row on the new name',
      actions: [
        { type: 'query/selectModel', modelId: 1 },
        // Descending, so page one is ids 600…576 — every one of them *behind*
        // the backfill cursor. Ascending would return the migrated rows and the
        // fallback would never be exercised: a passing test of nothing.
        { type: 'query/setSort', target: 'id', fieldName: null, direction: 'desc' },
        { type: 'query/run' },
      ],
      assert(world) {
        const bad: string[] = [];
        const rows = world.queryDraft.lastRun?.outcome?.rows ?? [];

        if (rows.length === 0) {
          return ['expected a page of rows, got none'];
        }

        // The row itself is still stored under the old key — asserted here
        // rather than only in the park, because this stage is the one claiming
        // the read bridged something.
        const newest = world.entries.find(e => e.id === rows[0].id);
        if (newest === undefined || !('city' in newest.fields)) {
          bad.push('expected the newest row to still be stored under city');
        }
        if (newest !== undefined && 'locality' in newest.fields) {
          bad.push('expected the newest row NOT to have been rewritten yet');
        }

        // And it comes back on the new name anyway. This is the fallback.
        const missing = rows.filter(r => r.fields.locality == null).length;
        if (missing > 0) {
          bad.push(`expected every row to resolve locality, got ${missing} null(s)`);
        }
        // The old key must not appear in a read result at all: the projection
        // is over the snapshot, and the snapshot knows only the current name.
        if (rows.some(r => 'city' in r.fields)) {
          bad.push('expected no row to carry the old key in the result');
        }
        return bad;
      },
    },
    {
      label: 'a filter on the old name is refused, and not bridged',
      actions: filterCityIs('aurora-600'),
      narrates: ['filter-refused'],
      assert(world) {
        const code = world.queryDraft.lastRun?.rejection?.errorCode;
        // `field_unknown`, not `field_not_filterable`: as far as the registry
        // is concerned there is no field called city any more. Writes converge
        // on the new name and filters fail loudly — the asymmetry is the
        // decision, because a rejected filter loses nothing and a mis-keyed
        // write loses data.
        return code === 'field_unknown'
          ? []
          : [`expected field_unknown, got '${code ?? 'no rejection'}'`];
      },
    },
    {
      label: 'resuming the Reconciler rewrites the last hundred and retires the bridge',
      actions: [{ type: 'daemon/togglePaused', daemon: 'reconciler' }, ...ticks(2)],
      narrates: ['rename-landed'],
      assert(world) {
        const bad: string[] = [];

        const field = world.fields.find(f => f.id === CITY);
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
        if (migrated !== 600) bad.push(`expected all 600 rewritten, got ${migrated}`);

        if (!world.events.some(e => e.event === 'rename_complete')) {
          bad.push('expected a rename_complete line in the log');
        }
        return bad;
      },
    },
  ],
};

export const SCENARIOS: readonly Scenario[] = [PROMOTION_WINDOW, WARM_PATH, HALF_MIGRATED];

export function scenarioById(id: ScenarioId): Scenario | undefined {
  return SCENARIOS.find(s => s.id === id);
}
