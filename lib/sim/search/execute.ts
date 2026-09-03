/**
 * `SearchService::execute()` — the one path `search()`, `read()` and `get()`
 * all take, and the evaluator that stands in for MySQL.
 *
 * `compile.ts` emits the SQL a real server would run; this module produces the
 * rows. The two are written against the same tree, the same strategy choice
 * and the same snapshot, and the headless verification asserts they agree —
 * the failure this guards against is a beautiful SQL panel captioning a filter
 * loop that does something else.
 *
 * ## What a filter actually reads
 *
 * **The slot column, never the JSON.** `entry_data.fields` is the complete
 * system of record and it is not what a filter touches: the predicate compiles
 * against `entry_slots_page_N.i_str_01`, and a row whose value has not been
 * mirrored there yet is simply not in the joined set. That has three
 * consequences the section has to show rather than hide:
 *
 *   - An entry written before its field was promoted has **no row on that
 *     page** until the backfill reaches it, so it matches nothing at all —
 *     `is_null` included, because `EXISTS (… AND col IS NULL)` still needs a
 *     row to exist.
 *   - An entry the backfill *has* reached, whose payload had no value for the
 *     field, has a row with a NULL column, and that one does match `is_null`.
 *   - The difference between those two is a chunk boundary, which is exactly
 *     what section D let the visitor stop in the middle of.
 *
 * ## String comparison is case- and accent-insensitive
 *
 * Every page table is `COLLATE=utf8mb4_0900_ai_ci`, so `eq "bandung"` matches
 * `Bandung` and `prefix "cafe"` matches `Café` — in the engine, on a real
 * server. An `Intl.Collator` at `sensitivity: 'base'` is the closest thing a
 * browser has, and it is used for every string comparison and for ordering.
 * It is an approximation of DUCET rather than a reimplementation of it; where
 * the two could disagree is deep in the tail of Unicode collation, and being
 * *approximately* right about a case-insensitive engine beats being exactly
 * wrong with `===`.
 */

import { emit } from '../emit';
import { line } from '../events';
import { nodeCount, isLeaf, type FilterNode, type FilterScalar, type LeafNode } from '../filter/ast';
import type { DeclaredType, SimEntry } from '../types';
import type { SimWorld } from '../world';
import {
  chooseStrategy,
  compileFetch,
  compileProbe,
  type CompileStrategy,
  type SqlFragment,
} from './compile';
import { decodeCursor, encodeCursor } from './cursor';
import { preFlightFilter, preFlightSort, type PreFlightRejection } from './preflight';
import { snapshotField, snapshotForModel, type Snapshot } from './snapshot';
import { directionOf, type SortSpec } from './sort';

export interface SearchRequest {
  tenantId: number;
  modelId: number;
  filter: FilterNode | null;
  sort: SortSpec | null;
  pageSize: number;
  cursor: string | null;
}

/** One returned row, as Query 2 hands it back. */
export interface SearchRow {
  id: number;
  createdAt: string;
  /**
   * The **snapshot's** fields, not the stored payload. See
   * {@link projectFields} — this used to be `entry_data.fields` verbatim, which
   * was wrong in three separate ways.
   */
  fields: Record<string, unknown>;
}

export interface SearchOutcome {
  rows: SearchRow[];
  nextCursor: string | null;
  hasMore: boolean;
  strategy: CompileStrategy;
  /** Query 1 and Query 2, for the plan panel. `fetch` is null for zero rows. */
  probe: SqlFragment;
  fetch: SqlFragment | null;
  /** The ids the probe chose, before the extra has-more row was dropped. */
  probeIds: number[];
  /** How many entries the probe had to consider — the filesort's population. */
  candidateCount: number;
  matchedCount: number;
  treeNodeCount: number;
}

export type SearchResult =
  | { ok: true; outcome: SearchOutcome }
  | { ok: false; rejection: PreFlightRejection }
  /** No snapshot: an unknown or deleting model. Nothing to reject *against*. */
  | { ok: false; rejection: null };

export function runSearch(
  world: SimWorld,
  request: SearchRequest,
  correlationId: string,
): { world: SimWorld; result: SearchResult } {
  const snapshot = snapshotForModel(world, request.modelId);
  if (snapshot === null) return { world, result: { ok: false, rejection: null } };

  // The pre-flight gate is `filter || sort || cursor`, not `filter` alone.
  // ADR 0041 widened it precisely because a "newest first" listing has no
  // filter, and the old condition let such a read skip field resolution, the
  // capability check and the cursor/sort agreement check entirely.
  if (request.filter !== null || request.sort !== null || request.cursor !== null) {
    if (request.filter !== null) {
      const filterCheck = preFlightFilter(request.filter, snapshot);
      if (!filterCheck.ok) {
        return { world: emitRejection(world, filterCheck.rejection, correlationId, request), result: filterCheck };
      }
    }
    const sortCheck = preFlightSort(request.sort, request.cursor, snapshot);
    if (!sortCheck.ok) {
      return { world: emitRejection(world, sortCheck.rejection, correlationId, request), result: sortCheck };
    }
  }

  const outcome = execute(world, request, snapshot);

  const next = emit(world, (nextSeq, tick) => [
    line(
      nextSeq(),
      tick,
      'api',
      'search_request',
      // No `latency_ms`. The engine measures one with `hrtime()`; the
      // simulation has nothing to measure, and a plausible millisecond count
      // would be a fabricated number in the one panel whose whole claim is
      // that these are the engine's own lines.
      {
        correlation_id: correlationId,
        tenant_id: request.tenantId,
        model_id: request.modelId,
        route: 'search',
        rows_returned: outcome.rows.length,
        has_more: outcome.hasMore,
        tree_node_count: outcome.treeNodeCount,
        compile_strategy: outcome.strategy,
      },
    ),
  ]);

  return { world: next, result: { ok: true, outcome } };
}

function emitRejection(
  world: SimWorld,
  rejection: PreFlightRejection,
  correlationId: string,
  request: SearchRequest,
): SimWorld {
  return emit(world, (nextSeq, tick) => [
    line(
      nextSeq(),
      tick,
      'api',
      rejection.event,
      {
        correlation_id: correlationId,
        tenant_id: request.tenantId,
        ...(rejection.event === 'capability_unsupported'
          ? { operator: rejection.operator ?? '', driver_class: 'MysqlNativeDriver' }
          : { reason: rejection.reason }),
        field_name: rejection.fieldName,
      },
      'warn',
    ),
  ]);
}

/* ------------------------------------------------------------------ *
 * The two queries
 * ------------------------------------------------------------------ */

function execute(world: SimWorld, request: SearchRequest, snapshot: Snapshot): SearchOutcome {
  const anchorId = anchorIdOf(request);
  const probe = compileProbe(
    {
      tenantId: request.tenantId,
      modelId: request.modelId,
      filter: request.filter,
      sort: request.sort,
      pageSize: request.pageSize,
      anchorId,
    },
    snapshot,
  );

  // Query 1: the bounded probe. Filter, then keyset, then order, then limit —
  // the order a server would apply them, so that `candidateCount` reports the
  // population a field sort would really filesort over.
  const candidates = world.entries.filter(
    e => e.tenantId === request.tenantId && e.modelId === request.modelId && e.deletedAt === null,
  );

  const matched = candidates.filter(entry =>
    request.filter === null ? true : matchesNode(entry, request.filter, snapshot),
  );

  const anchorValue = anchorId === null ? undefined : anchorValueOf(anchorId, request, snapshot, world);
  const walked =
    anchorId === null
      ? matched
      : matched.filter(entry => passesKeyset(entry, anchorId, anchorValue ?? null, request, snapshot));

  const ordered = [...walked].sort((a, b) => compareEntries(a, b, request, snapshot));

  // The `pageSize + 1` row is the whole has-more protocol: if it comes back
  // there is another page, and it is discarded rather than returned.
  const probeIds = ordered.slice(0, request.pageSize + 1).map(e => e.id);
  const hasMore = probeIds.length > request.pageSize;
  const pageIds = hasMore ? probeIds.slice(0, request.pageSize) : probeIds;

  // Query 2: materialise exactly those ids. Bounded by construction — the IN
  // list is never longer than one page, whatever matched.
  const byId = new Map(candidates.map(e => [e.id, e]));
  const rows: SearchRow[] = pageIds.map(id => {
    const entry = byId.get(id) as SimEntry;
    return { id: entry.id, createdAt: entry.createdAt, fields: projectFields(entry, snapshot) };
  });

  const lastId = pageIds[pageIds.length - 1];

  return {
    rows,
    hasMore,
    nextCursor: hasMore && lastId !== undefined ? encodeCursor(request.sort, lastId) : null,
    strategy: chooseStrategy(request.filter),
    probe,
    fetch: pageIds.length === 0 ? null : compileFetch(pageIds, request.tenantId),
    probeIds,
    candidateCount: candidates.length,
    matchedCount: matched.length,
    treeNodeCount: nodeCount(request.filter),
  };
}

/**
 * `ResultAssembler::assemble()` — build one row's fields from the snapshot.
 *
 * **This is a projection over the registry, not the stored document**, and that
 * distinction is the whole of it. It shipped returning `entry.fields` verbatim,
 * which was wrong three times over and was found by reading the engine's
 * assembler rather than by reading this file:
 *
 *   1. **Unknown keys do not appear in a read.** The engine iterates
 *      `array_keys($snapshot->fieldsByName)`, so a payload key with no registry
 *      row is invisible here. It is still stored, still returned by the point
 *      read and still in a JSON export artifact — which is the property section
 *      C teaches, and section B is where you see it. Showing it *here* made the
 *      two sections disagree about what a read returns.
 *   2. **A field absent from the payload materialises as `null`**, rather than
 *      as a missing key. ADR 0013 permits the omission; the read still has a
 *      column for it.
 *   3. **A field with no registry row can no longer leak.** That is what makes
 *      a deleted field disappear from results the instant severance commits,
 *      months of purge later — the delete window's headline claim, which the
 *      verbatim payload would have quietly contradicted.
 *
 * Two sources, in the engine's order:
 *
 *   - **The slot column**, whenever the field has a queryable slot. Note this
 *     can legitimately differ from the payload: the write path coerces for the
 *     column and stores the raw value in JSON, so `{"qty": "42"}` on an `int`
 *     field reads back as the number `42` here and as the string `"42"` in
 *     section B's `entry_data`. That is the engine, not a rounding error.
 *   - **The payload**, for everything else — `backfilling`, tombstoned, and
 *     every JSON-only field. Sourcing from the decoded payload is exactly a
 *     `JSON_EXTRACT(fields, '$.<name>')` projection: same bytes, no slot.
 *
 * The ADR 0036 fallback is on the payload branch's miss path only. While a
 * rename is draining, rows behind the cursor are still keyed by the old name,
 * and a single-path lookup on the new one would return null for every un-migrated
 * row — silently, and for the whole window. It costs one key test on a miss and
 * disappears when the backfill clears `previous_name`.
 */
function projectFields(entry: SimEntry, snapshot: Snapshot): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [name, field] of Object.entries(snapshot.fieldsByName)) {
    if (field.isIndexedNow && field.pageId !== null && field.slotColumn !== null) {
      // A LEFT JOIN: an entry with no row on the page yields null rather than
      // dropping out of the result. Reachable for a slot reserved through the
      // ADR 0007 exhaustion path, whose backfill covers only the queued rows.
      out[name] = entry.slots[field.pageId]?.[field.slotColumn] ?? null;
      continue;
    }

    if (name in entry.fields) {
      out[name] = entry.fields[name];
      continue;
    }

    out[name] =
      field.previousName !== null && field.previousName in entry.fields
        ? entry.fields[field.previousName]
        : null;
  }

  return out;
}

function anchorIdOf(request: SearchRequest): number | null {
  if (request.cursor === null) return null;
  const decoded = decodeCursor(request.cursor);
  // Pre-flight already rejected a malformed token, so this is total.
  return decoded.ok ? decoded.payload.entryId : null;
}

/* ------------------------------------------------------------------ *
 * Predicate evaluation
 * ------------------------------------------------------------------ */

/**
 * Does this entry satisfy the tree?
 *
 * One evaluator serves both strategies, and that is not a shortcut. A leaf is
 * "the entry has a row on the leaf's page **and** the predicate holds on it",
 * which is precisely what `EXISTS (SELECT 1 FROM page WHERE entry_id = … AND
 * pred)` means; and because an extension page is keyed by `entry_id`, the
 * INNER JOIN form of the same leaf admits exactly the same entries. The
 * strategies differ in how MySQL *executes* them, not in what they match —
 * which is the property that lets `chooseStrategy()` pick either one without
 * changing an answer.
 */
export function matchesNode(entry: SimEntry, node: FilterNode, snapshot: Snapshot): boolean {
  if (isLeaf(node)) return matchesLeaf(entry, node, snapshot);
  if (node.op === 'not') return !matchesNode(entry, node.arg, snapshot);
  if (node.op === 'and') return node.args.every(child => matchesNode(entry, child, snapshot));
  return node.args.some(child => matchesNode(entry, child, snapshot));
}

function matchesLeaf(entry: SimEntry, leaf: LeafNode, snapshot: Snapshot): boolean {
  const field = snapshotField(snapshot, leaf.field.name);
  if (field === null || field.pageId === null || field.slotColumn === null) return false;

  const pageRow = entry.slots[field.pageId];
  // No row on the page — the INNER JOIN drops the entry and the EXISTS is
  // false. Nothing below this line can rescue it, `is_null` included.
  if (pageRow === undefined) return false;

  const stored = pageRow[field.slotColumn] ?? null;
  return evaluate(leaf, stored, field.declaredType);
}

function evaluate(leaf: LeafNode, stored: unknown, declaredType: DeclaredType): boolean {
  if (leaf.op === 'is_null') return stored === null;
  if (leaf.op === 'is_not_null') return stored !== null;

  // SQL's three-valued logic: every comparison against NULL is UNKNOWN, and
  // UNKNOWN is not TRUE. `NOT (col = 5)` on a NULL column is therefore still
  // not a match, which is the part people get wrong when they reach for `!==`.
  if (stored === null || leaf.value === undefined) return false;

  const compare = (bound: FilterScalar): number =>
    compareSql(stored, normaliseBound(bound, declaredType));

  switch (leaf.op) {
    case 'eq':
      return compare(leaf.value as FilterScalar) === 0;
    case 'neq':
      return compare(leaf.value as FilterScalar) !== 0;
    case 'lt':
      return compare(leaf.value as FilterScalar) < 0;
    case 'lte':
      return compare(leaf.value as FilterScalar) <= 0;
    case 'gt':
      return compare(leaf.value as FilterScalar) > 0;
    case 'gte':
      return compare(leaf.value as FilterScalar) >= 0;
    case 'prefix':
      return matchesPrefix(stored, String(leaf.value));
    case 'in':
      return (leaf.value as FilterScalar[]).some(v => compare(v) === 0);
    case 'nin':
      return (leaf.value as FilterScalar[]).every(v => compare(v) !== 0);
    case 'between': {
      const [low, high] = leaf.value as FilterScalar[];
      return compare(low) >= 0 && compare(high) <= 0;
    }
    default:
      return false;
  }
}

/**
 * `col LIKE 'prefix%' ESCAPE '\'`, under a case-insensitive collation.
 *
 * The escaping cancels out: the compiler escapes the three LIKE
 * metacharacters precisely so they match literally, so evaluating that pattern
 * means comparing against the **unescaped** prefix. Comparison is by code
 * point so an astral character counts once, as MySQL counts characters rather
 * than bytes.
 */
function matchesPrefix(stored: unknown, prefix: string): boolean {
  const value = [...String(stored)];
  const wanted = [...prefix];
  if (value.length < wanted.length) return false;
  return collate(value.slice(0, wanted.length).join(''), prefix) === 0;
}

/**
 * A filter bound in the form the column holds it.
 *
 * Only datetime moves: the wire format demands RFC 3339 **with an explicit
 * offset** while a `DATETIME` slot holds naive UTC, so the bound is converted
 * to the instant it names before comparison.
 *
 * **MySQL does not do this, and the simulation diverges deliberately.**
 * Measured on a real MySQL 8.0.13 (2026-09-02), comparing a `DATETIME` column
 * against an RFC 3339 literal:
 *
 *   - `'…T10:00:00+07:00'` matches the row holding `10:00:00`, not the one
 *     holding `03:00:00` — the offset is parsed off and **thrown away**.
 *   - Every RFC 3339 literal, the `Z` form included, raises warning 1292
 *     `Incorrect datetime value`. The comparison still resolves and still
 *     plans as a `range` scan on the index; MySQL truncates at the zone
 *     designator and uses the leading `YYYY-MM-DDTHH:MM:SS`.
 *
 * So on `Z` — the form this page produces — the two agree exactly, and on any
 * other offset the engine is seven hours (or whatever) wrong while this is
 * right. Reproducing that would make the playground teach it, which is the one
 * thing the fidelity rules forbid; it is recorded here and filed against the
 * engine instead, the same way the recycled-slot sweep was in stage 4. If the
 * engine normalises the bound, delete this note, not the conversion.
 */
function normaliseBound(bound: FilterScalar, declaredType: DeclaredType): FilterScalar {
  if (declaredType !== 'datetime' || typeof bound !== 'string') return bound;
  const parsed = Date.parse(bound);
  if (Number.isNaN(parsed)) return bound;
  return new Date(parsed).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * MySQL's comparison, as far as a browser can reach it.
 *
 * Numbers compare numerically; everything else compares under the
 * accent-insensitive, case-insensitive collation every page table declares.
 */
function compareSql(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === 'number' || typeof b === 'number') {
    // A mixed comparison cannot arise: pre-flight has already rejected a bound
    // whose JSON type disagrees with the column's declared type.
    const an = Number(a);
    const bn = Number(b);
    return an === bn ? 0 : an < bn ? -1 : 1;
  }
  return collate(String(a), String(b));
}

/**
 * `utf8mb4_0900_ai_ci`, approximated.
 *
 * `sensitivity: 'base'` folds case and accents together, which is what `ai_ci`
 * means. Constructed once — a collator per comparison is the kind of thing
 * that makes a 600-row sort visibly slow in a browser.
 */
const COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base', numeric: false });

function collate(a: string, b: string): number {
  return COLLATOR.compare(a, b);
}

/* ------------------------------------------------------------------ *
 * Ordering and the keyset walk
 * ------------------------------------------------------------------ */

/** The sort value the ORDER BY reads for one entry, or null. */
function sortValueOf(
  entry: SimEntry,
  sort: SortSpec | null,
  snapshot: Snapshot,
): unknown {
  if (sort === null || sort.target === 'id') return entry.id;
  if (sort.target === 'created_at') return entry.createdAt;
  const field = snapshotField(snapshot, sort.fieldName ?? '');
  if (field === null || field.pageId === null || field.slotColumn === null) return null;
  // The sort join is LEFT, so an entry with no row on the page is kept and
  // reads NULL — turning that into an INNER join would silently make the sort
  // a filter, which is the trap `compile.ts` documents.
  return entry.slots[field.pageId]?.[field.slotColumn] ?? null;
}

function compareEntries(
  a: SimEntry,
  b: SimEntry,
  request: SearchRequest,
  snapshot: Snapshot,
): number {
  const direction = directionOf(request.sort);
  const sign = direction === 'asc' ? 1 : -1;

  if (request.sort !== null && request.sort.target !== 'id') {
    const av = sortValueOf(a, request.sort, snapshot);
    const bv = sortValueOf(b, request.sort, snapshot);
    const ordered = compareNullable(av, bv);
    if (ordered !== 0) return ordered * sign;
  }

  // entry_data.id is the implicit tiebreak, in the same direction. Without it
  // two rows sharing a sort value could swap between pages and be returned
  // twice or never.
  return (a.id === b.id ? 0 : a.id < b.id ? -1 : 1) * sign;
}

/** MySQL sorts NULL before every value ascending, and after them descending. */
function compareNullable(a: unknown, b: unknown): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compareSql(a, b);
}

function anchorValueOf(
  anchorId: number,
  request: SearchRequest,
  snapshot: Snapshot,
  world: SimWorld,
): unknown {
  const anchor = world.entries.find(e => e.id === anchorId && e.tenantId === request.tenantId);
  // The scalar-subquery form yields one row holding NULL when the anchor has
  // no row to read — a deleted anchor, or one with no row on the sort page.
  // The `SELECT … FROM …` form would yield zero rows and the CROSS JOIN would
  // annihilate the result set, which is why `compile.ts` writes it the way it
  // does and why this returns null rather than bailing out.
  if (anchor === undefined) return null;
  return sortValueOf(anchor, request.sort, snapshot);
}

/**
 * The keyset predicate, evaluated.
 *
 * A transcription of the three-branch SQL in `compile.ts`, not a shortcut past
 * it: "everything after the anchor in this ordering" is easy to write and easy
 * to get wrong at the NULL block, and writing it the same shape twice is what
 * makes a disagreement between the panel and the rows findable.
 */
function passesKeyset(
  entry: SimEntry,
  anchorId: number,
  anchorValue: unknown,
  request: SearchRequest,
  snapshot: Snapshot,
): boolean {
  const direction = directionOf(request.sort);
  const after = (cmp: number) => (direction === 'asc' ? cmp > 0 : cmp < 0);

  if (request.sort === null || request.sort.target === 'id') {
    return after(entry.id === anchorId ? 0 : entry.id < anchorId ? -1 : 1);
  }

  const value = sortValueOf(entry, request.sort, snapshot);

  const leadingBlock =
    direction === 'asc'
      ? anchorValue === null && value !== null
      : anchorValue !== null && value === null;
  if (leadingBlock) return true;

  if (anchorValue !== null && value !== null && after(compareSql(value, anchorValue))) return true;

  // `<=>` — NULL-safe equality, which is what makes the tiebreak work inside
  // the NULL block itself.
  const sameValue = value === null ? anchorValue === null : anchorValue !== null && compareSql(value, anchorValue) === 0;
  return sameValue && after(entry.id === anchorId ? 0 : entry.id < anchorId ? -1 : 1);
}
