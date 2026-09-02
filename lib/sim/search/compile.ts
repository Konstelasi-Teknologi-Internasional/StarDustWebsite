/**
 * The adaptive SQL compiler — `src/Search/Mysql/SqlFilterCompiler.php`, plus
 * Query 2 from `src/Read/BoundedFetch.php`.
 *
 * This module emits **SQL text and bindings, and executes nothing**. The rows
 * come from `execute.ts`, which walks the world; what this produces is the
 * query a real MySQL would have run, for the panel that claims exactly that.
 * Keeping the two apart is what stops the SQL becoming a decorative caption on
 * a hand-written filter loop — the evaluator and the compiler are written
 * against the same tree and the same strategy choice, and the headless
 * verification asserts they agree.
 *
 * ## The two strategies
 *
 * - **joins** — the root is `null` or a pure-AND tree of leaves. One
 *   `INNER JOIN entry_slots_page_N` per *distinct page* referenced, predicates
 *   ANDed in the outer WHERE. This is the Phase 4 shape verbatim, and it is
 *   what preserves the composite-index range scan: no fan-out, one row per
 *   entry per page, however many conditions stack.
 * - **exists** — any subtree contains an OR or a NOT. Every leaf becomes an
 *   `EXISTS (SELECT 1 FROM … )`, composed with native SQL `AND` / `OR` /
 *   `NOT`. Each EXISTS still hits the composite index on its own page.
 *
 * The tenant-isolation invariant holds on both, and on the two clauses sorting
 * adds: `tenant_id` is bound at the outer level and **replayed inside every
 * JOIN, every EXISTS, the sort join and the anchor subquery**. Any new
 * strategy has to be checked against that before anything else.
 */

import {
  collectLeaves,
  containsDisjunction,
  isLeaf,
  type FilterNode,
  type FilterScalar,
  type LeafNode,
} from '../filter/ast';
import { snapshotField, type Snapshot } from './snapshot';
import {
  directionOf,
  keysetOperator,
  sqlDirection,
  type SortSpec,
} from './sort';

export type CompileStrategy = 'joins' | 'exists';

export interface SqlFragment {
  sql: string;
  bindings: unknown[];
}

export interface ProbeRequest {
  tenantId: number;
  modelId: number;
  filter: FilterNode | null;
  sort: SortSpec | null;
  pageSize: number;
  /** The anchor entry id from a decoded cursor, or null on the first page. */
  anchorId: number | null;
}

export function chooseStrategy(filter: FilterNode | null): CompileStrategy {
  if (filter === null) return 'joins';
  return containsDisjunction(filter) ? 'exists' : 'joins';
}

/**
 * Query 1 — the bounded probe. Returns ids only, `pageSize + 1` of them.
 *
 * The extra row is the entire has-more protocol: if it comes back there is
 * another page, and it is discarded rather than returned. That is why no read
 * in this engine can tell you a total count.
 */
export function compileProbe(request: ProbeRequest, snapshot: Snapshot): SqlFragment {
  const strategy = chooseStrategy(request.filter);

  const filterBindings: unknown[] = [];
  const aliasByPage: Record<number, string> = {};
  let joinsSql = '';
  let filterWhere = '';

  if (strategy === 'joins') {
    const compiled = compileAsJoins(collectLeaves(request.filter), snapshot, filterBindings);
    joinsSql = compiled.joins;
    filterWhere = compiled.predicates;
    Object.assign(aliasByPage, compiled.aliasByPage);
  } else {
    // Non-null: chooseStrategy never picks 'exists' for a null tree.
    filterWhere = compileAsExists(request.filter as FilterNode, snapshot, filterBindings);
  }

  const [sortJoinSql, sortExpression] = compileSortTarget(request.sort, snapshot, aliasByPage);
  joinsSql = [joinsSql, sortJoinSql].filter(part => part !== '').join(' ');

  const anchorBindings: unknown[] = [];
  const keysetBindings: unknown[] = [];
  let anchorJoinSql = '';
  let keysetWhere = '';

  if (request.anchorId !== null) {
    if (sortExpression === null) {
      // Ordering by entry_data.id: the cursor *is* the sort value, so there is
      // nothing to look up.
      keysetWhere = `entry_data.id ${keysetOperator(directionOf(request.sort))} ?`;
      keysetBindings.push(request.anchorId);
    } else {
      const anchor = compileAnchorJoin(request.sort, snapshot, request.anchorId, request.tenantId);
      anchorJoinSql = anchor.sql;
      anchorBindings.push(...anchor.bindings);
      keysetWhere = compileKeysetPredicate(sortExpression, directionOf(request.sort));
      keysetBindings.push(request.anchorId);
    }
  }

  const whereClauses = [
    'entry_data.tenant_id = ?',
    'entry_data.model_id = ?',
    'entry_data.deleted_at IS NULL',
  ];
  const outerBindings: unknown[] = [request.tenantId, request.modelId];

  if (keysetWhere !== '') whereClauses.push(keysetWhere);
  if (filterWhere !== '') whereClauses.push(filterWhere);

  const sql =
    'SELECT entry_data.id FROM entry_data' +
    (joinsSql === '' ? '' : ' ' + joinsSql) +
    (anchorJoinSql === '' ? '' : ' ' + anchorJoinSql) +
    ' WHERE ' +
    whereClauses.join(' AND ') +
    ' ORDER BY ' +
    compileOrderBy(sortExpression, directionOf(request.sort)) +
    ' LIMIT ?';

  return {
    sql,
    // Clause order in the emitted SQL: FROM (anchor) → WHERE (tenant, model,
    // keyset, filter) → LIMIT. Collected per clause and concatenated here,
    // because a sort puts the anchor's bindings ahead of every other and makes
    // the keyset clause variable-length — a flat list with a fixed tail splice
    // only worked while every query had the same outer shape.
    bindings: [
      ...anchorBindings,
      ...outerBindings,
      ...keysetBindings,
      ...filterBindings,
      request.pageSize + 1,
    ],
  };
}

/**
 * Query 2 — materialise exactly the ids the probe chose.
 *
 * Bounded by construction: the IN list is never longer than one page. This is
 * the half that makes the read cost independent of how many rows matched.
 */
export function compileFetch(entryIds: number[], tenantId: number): SqlFragment {
  const columns = [
    'entry_data.id            AS id',
    'entry_data.tenant_id     AS tenant_id',
    'entry_data.model_id      AS model_id',
    'entry_data.created_at    AS created_at',
    'entry_data.deleted_at    AS deleted_at',
    'entry_data.fields        AS fields_json',
  ];
  const placeholders = entryIds.map(() => '?').join(',');

  return {
    sql:
      'SELECT ' +
      columns.join(', ') +
      ' FROM entry_data' +
      ` WHERE entry_data.id IN (${placeholders})` +
      ' AND entry_data.tenant_id = ?',
    bindings: [...entryIds, tenantId],
  };
}

/* ------------------------------------------------------------------ *
 * Sorting
 * ------------------------------------------------------------------ */

/**
 * Resolve the sort target to an outer-query expression, joining its page when
 * the target is a field.
 *
 * Two traps, both load-bearing:
 *
 * - **The page is joined whatever the strategy chose.** You cannot `ORDER BY`
 *   a column that exists only inside an EXISTS subquery, so the EXISTS path
 *   grows an outer join it otherwise has none of.
 * - **That join is LEFT, never INNER.** Filter joins are INNER because a
 *   filter demands a match; an INNER sort join would silently reduce the
 *   result to "entries that happen to have a row on this page", turning a sort
 *   into a filter. When the filter already joined the page, its alias is
 *   reused instead of joining twice.
 */
function compileSortTarget(
  sort: SortSpec | null,
  snapshot: Snapshot,
  aliasByPage: Record<number, string>,
): [string, string | null] {
  if (sort === null || sort.target === 'id') return ['', null];
  if (sort.target === 'created_at') return ['', 'entry_data.created_at'];

  const slot = resolvedSortSlot(sort, snapshot);
  if (aliasByPage[slot.pageId] !== undefined) {
    return ['', `${aliasByPage[slot.pageId]}.${slot.slotColumn}`];
  }

  const table = snapshot.pageTableNames[slot.pageId];
  const alias = 'sp';
  const join =
    `LEFT JOIN ${table} ${alias}` +
    ` ON ${alias}.entry_id = entry_data.id` +
    ` AND ${alias}.tenant_id = entry_data.tenant_id`;
  return [join, `${alias}.${slot.slotColumn}`];
}

/**
 * The one-row derived table holding the anchor row's sort value.
 *
 * Written as `SELECT (SELECT …) AS av` rather than `SELECT … FROM …`
 * deliberately: the second form yields **zero** rows when the anchor has no
 * row on that page, and a CROSS JOIN against zero rows annihilates the whole
 * result set. The scalar-subquery form always yields exactly one row, NULL
 * when there is nothing to find — which the keyset predicate already handles
 * as its NULL block.
 *
 * `tenant_id` is *bound* rather than correlated to `entry_data.tenant_id`,
 * which is what keeps the subquery uncorrelated and therefore evaluated once
 * instead of per row.
 */
function compileAnchorJoin(
  sort: SortSpec | null,
  snapshot: Snapshot,
  anchorId: number,
  tenantId: number,
): SqlFragment {
  let inner: string;
  if (sort !== null && sort.target === 'created_at') {
    inner = 'SELECT created_at FROM entry_data WHERE id = ? AND tenant_id = ?';
  } else {
    const slot = resolvedSortSlot(sort as SortSpec, snapshot);
    const table = snapshot.pageTableNames[slot.pageId];
    inner = `SELECT ${slot.slotColumn} FROM ${table} WHERE entry_id = ? AND tenant_id = ?`;
  }
  return {
    sql: `CROSS JOIN (SELECT (${inner}) AS av) sort_anchor`,
    bindings: [anchorId, tenantId],
  };
}

/**
 * The keyset predicate for a non-id sort.
 *
 * Three branches, and every one is load-bearing because a slot column is
 * nullable — a row whose value has not been mirrored into its slot reads NULL
 * here. MySQL sorts NULL first ascending and last descending, so the NULL
 * block has to be walked in the right place rather than dropped: `col > NULL`
 * is UNKNOWN, and the naive two-branch predicate silently loses every NULL
 * row. `<=>` is the NULL-safe equality that makes the tiebreak branch work
 * inside the NULL block itself.
 */
export function compileKeysetPredicate(sortExpression: string, direction: 'asc' | 'desc'): string {
  const op = keysetOperator(direction);
  const leadingBlock =
    direction === 'asc'
      ? `(sort_anchor.av IS NULL AND ${sortExpression} IS NOT NULL)`
      : `(sort_anchor.av IS NOT NULL AND ${sortExpression} IS NULL)`;

  return (
    '(' +
    leadingBlock +
    ` OR (sort_anchor.av IS NOT NULL AND ${sortExpression} ${op} sort_anchor.av)` +
    ` OR (${sortExpression} <=> sort_anchor.av AND entry_data.id ${op} ?)` +
    ')'
  );
}

function compileOrderBy(sortExpression: string | null, direction: 'asc' | 'desc'): string {
  const dir = sqlDirection(direction);
  // entry_data.id always trails in the same direction. It is the tiebreak that
  // makes the ordering total, which is what makes the cursor stable — without
  // it two rows sharing a sort value could swap between pages and be returned
  // twice or never.
  return sortExpression === null ? `entry_data.id ${dir}` : `${sortExpression} ${dir}, entry_data.id ${dir}`;
}

export function resolvedSortSlot(
  sort: SortSpec,
  snapshot: Snapshot,
): { pageId: number; slotColumn: string } {
  const field = snapshotField(snapshot, sort.fieldName ?? '');
  if (field === null || field.pageId === null || field.slotColumn === null) {
    // Pre-flight resolved this field and the driver declared it sortable, so a
    // miss here is the engine disagreeing with itself rather than a caller
    // error — which is why it throws rather than degrading to an id sort.
    throw new Error(`compiler reached sort field '${sort.fieldName}' with no resolved slot`);
  }
  return { pageId: field.pageId, slotColumn: field.slotColumn };
}

/* ------------------------------------------------------------------ *
 * The two strategies
 * ------------------------------------------------------------------ */

function compileAsJoins(
  leaves: LeafNode[],
  snapshot: Snapshot,
  bindings: unknown[],
): { joins: string; predicates: string; aliasByPage: Record<number, string> } {
  const aliasByPage: Record<number, string> = {};
  const joins: string[] = [];

  for (const leaf of leaves) {
    const { pageId } = resolvedSlotFor(leaf, snapshot);
    if (aliasByPage[pageId] !== undefined) continue;
    const alias = 'p' + Object.keys(aliasByPage).length;
    aliasByPage[pageId] = alias;
    const table = snapshot.pageTableNames[pageId];
    joins.push(
      `INNER JOIN ${table} ${alias}` +
        ` ON ${alias}.entry_id = entry_data.id` +
        ` AND ${alias}.tenant_id = entry_data.tenant_id`,
    );
  }

  const predicates = leaves.map(leaf => {
    const { pageId, slotColumn } = resolvedSlotFor(leaf, snapshot);
    return compileLeafPredicate(leaf, `${aliasByPage[pageId]}.${slotColumn}`, bindings);
  });

  return { joins: joins.join(' '), predicates: predicates.join(' AND '), aliasByPage };
}

function compileAsExists(node: FilterNode, snapshot: Snapshot, bindings: unknown[]): string {
  if (isLeaf(node)) {
    const { pageId, slotColumn } = resolvedSlotFor(node, snapshot);
    const table = snapshot.pageTableNames[pageId];
    const predicate = compileLeafPredicate(node, `s.${slotColumn}`, bindings);
    return (
      `EXISTS (SELECT 1 FROM ${table} s` +
      ' WHERE s.tenant_id = entry_data.tenant_id' +
      ' AND s.entry_id = entry_data.id' +
      ` AND ${predicate})`
    );
  }
  if (node.op === 'not') {
    return 'NOT (' + compileAsExists(node.arg, snapshot, bindings) + ')';
  }
  const joiner = node.op === 'and' ? ' AND ' : ' OR ';
  return '(' + node.args.map(child => compileAsExists(child, snapshot, bindings)).join(joiner) + ')';
}

function compileLeafPredicate(leaf: LeafNode, column: string, bindings: unknown[]): string {
  switch (leaf.op) {
    case 'eq':
      return scalarPredicate(column, '=', leaf, bindings);
    case 'neq':
      return scalarPredicate(column, '<>', leaf, bindings);
    case 'lt':
      return scalarPredicate(column, '<', leaf, bindings);
    case 'lte':
      return scalarPredicate(column, '<=', leaf, bindings);
    case 'gt':
      return scalarPredicate(column, '>', leaf, bindings);
    case 'gte':
      return scalarPredicate(column, '>=', leaf, bindings);
    case 'prefix':
      bindings.push(escapeLikePrefix(String(scalarOf(leaf))) + '%');
      return `${column} LIKE ? ESCAPE '\\\\'`;
    case 'in':
    case 'nin': {
      const values = listOf(leaf);
      const placeholders = values.map(() => '?').join(',');
      bindings.push(...values);
      return `${column} ${leaf.op === 'in' ? 'IN' : 'NOT IN'} (${placeholders})`;
    }
    case 'between': {
      const range = listOf(leaf);
      bindings.push(range[0], range[1]);
      return `${column} BETWEEN ? AND ?`;
    }
    case 'is_null':
      return `${column} IS NULL`;
    case 'is_not_null':
      return `${column} IS NOT NULL`;
  }
}

function scalarPredicate(
  column: string,
  op: string,
  leaf: LeafNode,
  bindings: unknown[],
): string {
  bindings.push(scalarOf(leaf));
  return `${column} ${op} ?`;
}

/**
 * The three LIKE metacharacters, escaped before the `%` is appended.
 *
 * Without this a `prefix` of `50%` matches everything starting with `50`
 * followed by anything, and a `_` matches any single character — so a filter
 * for `a_b` would quietly return `axb`. The `ESCAPE '\\'` clause on the
 * predicate is what makes the backslashes mean what they say.
 */
export function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function scalarOf(leaf: LeafNode): FilterScalar {
  if (leaf.value === undefined || Array.isArray(leaf.value)) {
    throw new Error(`operator '${leaf.op}' requires a scalar value`);
  }
  return leaf.value;
}

function listOf(leaf: LeafNode): FilterScalar[] {
  if (!Array.isArray(leaf.value)) {
    throw new Error(`operator '${leaf.op}' requires a list value`);
  }
  return leaf.value;
}

export function resolvedSlotFor(
  leaf: LeafNode,
  snapshot: Snapshot,
): { pageId: number; slotColumn: string } {
  const field = snapshotField(snapshot, leaf.field.name);
  if (field === null || field.pageId === null || field.slotColumn === null) {
    throw new Error(`leaf for field '${leaf.field.name}' reached the compiler unresolved`);
  }
  return { pageId: field.pageId, slotColumn: field.slotColumn };
}
