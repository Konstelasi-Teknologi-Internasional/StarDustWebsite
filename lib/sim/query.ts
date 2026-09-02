/**
 * The filter under construction, and the tree edits the builder performs.
 *
 * The third piece of playground state with no table behind it, after
 * {@link ./draft.ts} (the model being defined) and {@link ./payload.ts} (the
 * entry being composed), and it lives on the world for the same three reasons:
 * a half-built filter survives a refresh, the guided tour can script "add a
 * condition on city" through the same actions a human uses, and every rule
 * about what an operator means stays in `lib/sim/`.
 *
 * **The draft holds a real `FilterNode`, not a builder-flavoured copy of one.**
 * That is what makes the round-trip claim literal rather than decorative: the
 * JSON pane is `encodeEnvelope(draft.tree)`, running the query decodes that
 * same text back, and typing into the pane replaces the tree with what the
 * decoder produced. Two tree shapes with a converter between them would have
 * to be kept in agreement by hand, and the first thing to drift would be the
 * one the panel claims is the wire format.
 *
 * Nodes are addressed by **path** — a list of child indices, where a `not`
 * node's single child is index 0. Paths are also the React keys. An AST node
 * has no identity of its own and inventing one would put a field in the tree
 * that the wire format does not have, in the module whose job is to be the
 * wire format.
 */

import type { FilterError, FilterNode, FilterScalar, LeafNode, LeafOperator } from './filter/ast';
import { CLOSED_V1, isLeaf, isPresenceOperator, isRangeOperator, isSetOperator } from './filter/ast';
import type { SearchOutcome } from './search/execute';
import type { PreFlightRejection } from './search/preflight';
import type { SortDirection, SortTarget } from './search/sort';
import type { DeclaredType } from './types';

/** What the last run produced — exactly one of these three is non-null. */
export interface QueryRun {
  /** Rows, the plan, and the counters. */
  outcome: SearchOutcome | null;
  /** A pre-flight refusal: the field exists but the query cannot be served. */
  rejection: PreFlightRejection | null;
  /** A wire-format refusal, carrying its JSON Pointer. */
  wireError: FilterError | null;
  /** The exact envelope that ran, so the panel never re-derives it. */
  ranText: string;
}

export interface QueryDraft {
  modelId: number | null;

  /** `null` is match-all — the envelope omits the `filter` key entirely. */
  tree: FilterNode | null;

  /**
   * The visitor's own text, once they have typed into the wire pane. `null`
   * means the pane is derived from {@link tree} and re-renders as it changes.
   * Held rather than regenerated so that their whitespace, key order and
   * half-finished edits survive a re-render.
   */
  wireText: string | null;
  /** A decode failure for {@link wireText}, cleared by the next edit. */
  wireError: FilterError | null;

  sortTarget: SortTarget;
  sortFieldName: string | null;
  sortDirection: SortDirection;

  pageSize: number;
  /**
   * The tokens walked so far. Empty on the first page; the last element is the
   * cursor the current page was fetched with, so "back" is a pop and there is
   * no need to store a page number the engine could not produce anyway.
   */
  cursors: string[];

  lastRun: QueryRun | null;
  /** Monotonic source of nothing in the database — see {@link ./draft.ts}. */
  nextKey: number;
}

export function emptyQueryDraft(): QueryDraft {
  return {
    modelId: null,
    tree: null,
    wireText: null,
    wireError: null,
    sortTarget: 'id',
    sortFieldName: null,
    sortDirection: 'asc',
    // Small enough that the 600-row seed pages several times, which is the
    // only way the cursor is worth showing at all.
    pageSize: 10,
    cursors: [],
    lastRun: null,
    nextKey: 1,
  };
}

/* ------------------------------------------------------------------ *
 * Which operators a field can take
 * ------------------------------------------------------------------ */

/**
 * The operators offered for a field of this type.
 *
 * **A narrowing of the UI, not of the engine.** All twelve decode against any
 * field; what makes `prefix` meaningless on an `int` is that the decoder
 * requires its value to be a string and pre-flight then requires the value to
 * match the field's declared type — the two rules meet at "always rejected".
 * Offering it in the dropdown would be offering a guaranteed error, and the
 * section has enough genuine ones.
 */
export function operatorsFor(declaredType: DeclaredType): readonly LeafOperator[] {
  if (declaredType === 'string') return CLOSED_V1;
  return CLOSED_V1.filter(op => op !== 'prefix');
}

/**
 * A value typed into the builder, as the JSON scalar it becomes.
 *
 * An `int` or `numeric` field takes the number when the text is one and the
 * **raw string when it is not** — which is what makes `value_type_mismatch`
 * reachable by a visitor who simply typed `ten` into a number box, rather than
 * only by someone hand-editing JSON. Silently dropping the condition, or
 * coercing it the way the *write* path would, would hide the one asymmetry
 * this section exists to show: writes converge, reads refuse.
 */
export function parseBuilderValue(text: string, declaredType: DeclaredType): FilterScalar {
  if (declaredType !== 'int' && declaredType !== 'numeric') return text;
  // JSON's own number grammar, so that what the builder produces is what a
  // gateway could have sent. `Number()` would accept '0x1A' and ' 12 '.
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(text.trim()) && text.trim() !== '') {
    return Number(text.trim());
  }
  return text;
}

/** The comma-separated form an `in` / `nin` box takes, split and parsed. */
export function parseBuilderList(text: string, declaredType: DeclaredType): FilterScalar[] {
  return text
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '')
    .map(part => parseBuilderValue(part, declaredType));
}

/** The inverse, for rendering a list value back into its box. */
export function formatBuilderValue(value: LeafNode['value']): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) return value.map(v => String(v)).join(', ');
  return String(value);
}

/**
 * A fresh leaf for a field.
 *
 * Starts on `eq` with an empty value, which is a filter the decoder accepts
 * (an empty string is a scalar) and which returns nothing until the visitor
 * types — an empty condition that rejected on sight would make adding one feel
 * like a mistake.
 */
export function newLeaf(modelName: string, fieldName: string): LeafNode {
  return { op: 'eq', field: { model: modelName, name: fieldName }, value: '' };
}

/**
 * Re-shape a leaf's value for a change of operator.
 *
 * Each operator class wants a different value shape, and carrying the old one
 * across produces a tree the decoder rejects for a reason the visitor did not
 * cause — a `between` left holding a bare string is `node_malformed`, which is
 * a true error about a filter nobody wrote.
 */
export function retypeLeafValue(leaf: LeafNode, op: LeafOperator): LeafNode {
  if (isPresenceOperator(op)) {
    const { value: _dropped, ...rest } = leaf;
    return { ...rest, op };
  }
  const current = leaf.value;
  if (isRangeOperator(op)) {
    const list = Array.isArray(current) ? current : current === undefined ? [] : [current];
    return { ...leaf, op, value: [list[0] ?? '', list[1] ?? ''] };
  }
  if (isSetOperator(op)) {
    const list = Array.isArray(current) ? current : current === undefined ? [] : [current];
    return { ...leaf, op, value: list.length === 0 ? [''] : list };
  }
  const scalar = Array.isArray(current) ? (current[0] ?? '') : (current ?? '');
  return { ...leaf, op, value: scalar };
}

/* ------------------------------------------------------------------ *
 * Addressing and editing the tree
 * ------------------------------------------------------------------ */

export type NodePath = number[];

export function pathKey(path: NodePath): string {
  return path.length === 0 ? 'root' : path.join('.');
}

export function nodeAt(tree: FilterNode | null, path: NodePath): FilterNode | null {
  let node = tree;
  for (const index of path) {
    if (node === null || isLeaf(node)) return null;
    node = node.op === 'not' ? node.arg : (node.args[index] ?? null);
  }
  return node;
}

/** Replace the node at `path`; a `null` replacement removes it. */
export function replaceAt(
  tree: FilterNode | null,
  path: NodePath,
  replacement: FilterNode | null,
): FilterNode | null {
  if (tree === null) return replacement;
  if (path.length === 0) return replacement;
  return rewrite(tree, path, replacement);
}

function rewrite(node: FilterNode, path: NodePath, replacement: FilterNode | null): FilterNode | null {
  const [index, ...rest] = path;
  if (index === undefined) return replacement;

  if (isLeaf(node)) return node;

  if (node.op === 'not') {
    const child = rest.length === 0 ? replacement : rewrite(node.arg, rest, replacement);
    // A `not` with nothing under it is not expressible — the wire format
    // requires a singular `arg` — so removing its child removes the node.
    return child === null ? null : { ...node, arg: child };
  }

  const args: FilterNode[] = [];
  node.args.forEach((child, i) => {
    if (i !== index) {
      args.push(child);
      return;
    }
    const next = rest.length === 0 ? replacement : rewrite(child, rest, replacement);
    if (next !== null) args.push(next);
  });

  // An `and` / `or` needs at least one child; emptying it removes it, and a
  // single remaining child collapses the group rather than leaving a composite
  // that says nothing. Both are what the decoder's arity rules require.
  if (args.length === 0) return null;
  if (args.length === 1) return args[0] as FilterNode;
  return { ...node, args };
}

/**
 * Add a condition beside the node at `path`, or as the new root.
 *
 * The first condition becomes the root leaf; the second wraps both in an
 * `and`, which is the shape a visitor means by "another condition" and is also
 * the shape that keeps the compiler on the join strategy for as long as
 * possible.
 */
export function addLeaf(tree: FilterNode | null, leaf: LeafNode): FilterNode {
  if (tree === null) return leaf;
  if (!isLeaf(tree) && (tree.op === 'and' || tree.op === 'or')) {
    return { ...tree, args: [...tree.args, leaf] };
  }
  return { op: 'and', args: [tree, leaf] };
}

/** Wrap a subtree in a group of the given kind — this is where OR enters. */
export function wrapAt(
  tree: FilterNode | null,
  path: NodePath,
  kind: 'and' | 'or' | 'not',
): FilterNode | null {
  const target = nodeAt(tree, path);
  if (target === null) return tree;
  const wrapped: FilterNode =
    kind === 'not' ? { op: 'not', arg: target } : { op: kind, args: [target] };
  return replaceAt(tree, path, wrapped);
}

/** Flip an `and` to an `or` in place, and back. */
export function toggleGroupAt(tree: FilterNode | null, path: NodePath): FilterNode | null {
  const target = nodeAt(tree, path);
  if (target === null || isLeaf(target) || target.op === 'not') return tree;
  return replaceAt(tree, path, { ...target, op: target.op === 'and' ? 'or' : 'and' });
}
