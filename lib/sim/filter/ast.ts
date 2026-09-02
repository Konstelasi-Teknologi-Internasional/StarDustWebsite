/**
 * The QueryFilter input language, typed.
 *
 * A mirror of the engine's `src/Filter/` — the AST shapes, the closed operator
 * vocabulary, the bounds, and the thirteen-code error taxonomy. Like the
 * decoder beside it, **nothing in this package knows the world exists**: the
 * engine's decoder deliberately never consults the registry so that it stays
 * reusable in offline tooling, and splitting the simulation the same way is
 * what keeps "is this JSON well-formed" a different question from "does this
 * field exist", which is the distinction section E's two rejection shapes are
 * built on.
 *
 * PROVENANCE — transcribed from `src/Filter/Operator.php`,
 * `src/Filter/Limits/FilterLimits.php` and `src/Filter/ValidationErrorCode.php`
 * as of 2026-09-02. This is the **third** unverifiable mirror of the engine in
 * this repo, after `events.ts` (ADR 0020's vocabulary) and `ddl.ts` (the
 * bootstrap DDL). Nothing here can prove it still matches; an engine change
 * lands in both repos in the same commit or this section starts lying.
 */

/**
 * The twelve closed-v1 leaf operators.
 *
 * A `const` tuple with the union derived from it, on `events.ts`'s rule: an
 * invented operator is then a `npm run typecheck` failure rather than a
 * plausible-looking string in a dropdown. Drivers may declare *additional*
 * operators through the capability interface — see `preflight.ts` for why that
 * extension point exists here but is not reachable.
 */
export const CLOSED_V1 = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'nin',
  'prefix',
  'between',
  'is_null',
  'is_not_null',
] as const;

export type LeafOperator = (typeof CLOSED_V1)[number];

export const COMPOSITES = ['and', 'or', 'not'] as const;
export type CompositeOperator = (typeof COMPOSITES)[number];

/** Operators taking one scalar. */
export const SINGLE_VALUE = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'prefix'] as const;
/** Operators taking a non-empty array. */
export const SET = ['in', 'nin'] as const;
/** Operators taking exactly two elements. */
export const RANGE = ['between'] as const;
/** Operators taking no value key at all — supplying one is `value_unexpected`. */
export const PRESENCE = ['is_null', 'is_not_null'] as const;

export function isLeafOperator(op: string): op is LeafOperator {
  return (CLOSED_V1 as readonly string[]).includes(op);
}

export function isCompositeOperator(op: string): op is CompositeOperator {
  return (COMPOSITES as readonly string[]).includes(op);
}

export function isPresenceOperator(op: LeafOperator): boolean {
  return (PRESENCE as readonly string[]).includes(op);
}

export function isSetOperator(op: LeafOperator): boolean {
  return (SET as readonly string[]).includes(op);
}

export function isRangeOperator(op: LeafOperator): boolean {
  return (RANGE as readonly string[]).includes(op);
}

/**
 * A leaf's value, in JSON terms.
 *
 * The wire format carries JSON types and the engine compares them against the
 * field's `declared_type` **without coercing** — which is the opposite of the
 * write path, where `{"qty": "42"}` against an `int` field is accepted and
 * coerced into the slot. A filter saying `"42"` against that same field is
 * rejected with `value_type_mismatch`. The asymmetry is deliberate in the
 * engine: a rejected filter loses nothing, while a rejected write loses data.
 */
export type FilterScalar = string | number | boolean;

/**
 * `{"model": "...", "name": "..."}`.
 *
 * `model` is required by the wire format and is then read by nothing on the
 * execution path: every leaf resolves by `name` against the snapshot for the
 * request's own model id. It survives so logs can echo the consumer's own
 * spelling, which is also why a model rename breaks no stored filter.
 */
export interface FieldRef {
  model: string;
  name: string;
}

export interface LeafNode {
  op: LeafOperator;
  field: FieldRef;
  /** Absent for the two presence operators, present for every other. */
  value?: FilterScalar | FilterScalar[];
}

export interface AndNode {
  op: 'and';
  args: FilterNode[];
}

export interface OrNode {
  op: 'or';
  args: FilterNode[];
}

export interface NotNode {
  op: 'not';
  arg: FilterNode;
}

export type FilterNode = LeafNode | AndNode | OrNode | NotNode;

export function isLeaf(node: FilterNode): node is LeafNode {
  return !isCompositeOperator(node.op);
}

/**
 * Bounds, per the wire-format blueprint §4.6.
 *
 * The engine lets an operator tune all six through `Config`; the playground
 * ships the defaults, because they are what an out-of-the-box deployment
 * enforces and a tuned bound would make the rejection messages unreproducible.
 */
export const FILTER_LIMITS = {
  maxDepth: 8,
  maxNodes: 256,
  maxArgs: 64,
  maxInElements: 1024,
  maxStringLength: 4096,
  /** Bytes, not characters — the engine caps with `strlen()` before parsing. */
  maxPayloadBytes: 65_536,
} as const;

/**
 * The closed thirteen-code discriminator set.
 *
 * Nine belong to the decoder and four to pre-flight, and which is which is the
 * whole shape of the section: the first nine are answerable from the JSON
 * alone, the last four need the registry and the driver. Adding a code
 * requires a blueprint amendment in the design repo, so this tuple is closed
 * for the same reason `EVENT_NAMES` is.
 */
export const VALIDATION_ERROR_CODES = [
  'envelope_malformed',
  'node_malformed',
  'operator_unknown',
  'capability_unsupported',
  'field_unknown',
  'field_not_filterable',
  'value_type_mismatch',
  'value_count_mismatch',
  'value_unexpected',
  'value_out_of_bounds',
  'nesting_too_deep',
  'node_count_exceeded',
  'version_unsupported',
] as const;

export type ValidationErrorCode = (typeof VALIDATION_ERROR_CODES)[number];

/**
 * One rejection.
 *
 * `jsonPointer` is RFC 6901 and is empty for the four pre-flight codes — the
 * engine's pre-flight raises with `jsonPointer: ''` because by then it is
 * holding an AST, not a document, and pointing into a JSON text the caller may
 * never have sent would be an invention. The panel renders that absence rather
 * than hiding it.
 */
export interface FilterError {
  errorCode: ValidationErrorCode;
  jsonPointer: string;
  message: string;
  details?: Record<string, string | number | boolean | null>;
}

/* ------------------------------------------------------------------ *
 * Tree shape questions
 * ------------------------------------------------------------------ */

/** Total nodes, which is what `search_request` reports as `tree_node_count`. */
export function nodeCount(node: FilterNode | null): number {
  if (node === null) return 0;
  if (isLeaf(node)) return 1;
  if (node.op === 'not') return 1 + nodeCount(node.arg);
  return node.args.reduce((total, child) => total + nodeCount(child), 1);
}

/**
 * Whether any subtree contains an OR or a NOT.
 *
 * This is the whole of the compiler's strategy choice: a pure-AND tree keeps
 * the Phase 4 join shape and its composite-index range scan, and anything else
 * has to become EXISTS subqueries.
 */
export function containsDisjunction(node: FilterNode): boolean {
  if (node.op === 'or' || node.op === 'not') return true;
  if (node.op === 'and') return node.args.some(containsDisjunction);
  return false;
}

/**
 * Flatten a pure-AND tree to its leaves.
 *
 * Only valid on a tree {@link containsDisjunction} rejects — the engine throws
 * a `LogicException` when it is called on anything else, and returning an
 * empty list instead would let a mis-chosen strategy compile to a query that
 * silently matches everything.
 */
export function collectLeaves(node: FilterNode | null): LeafNode[] {
  if (node === null) return [];
  if (isLeaf(node)) return [node];
  if (node.op === 'and') return node.args.flatMap(collectLeaves);
  throw new Error('collectLeaves is only valid on pure-AND trees');
}
