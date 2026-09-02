/**
 * The wire-format decoder — `string → FilterNode | null`.
 *
 * A transcription of `src/Filter/Json/JsonFilterDecoder.php`. It owns nine of
 * the thirteen error codes: everything answerable from the document alone,
 * with no registry and no driver. Validation is **fail-fast** — only the first
 * violation is reported, exactly as the engine does, because a decoder that
 * collected every error would have to keep walking a tree it has already
 * decided is malformed.
 *
 * The public entry point returns a result rather than throwing, on the
 * `CoercionResult` / `SplitOutcome` precedent: the reducer that calls it has to
 * stay pure and total. Internally it throws and catches once, which is what
 * lets the recursive walk read like the engine's.
 *
 * ## Three places PHP's array model shows through, and are reproduced anyway
 *
 * `json_decode($s, true)` collapses JSON `{}` and `[]` to the same PHP `[]`,
 * so the engine cannot tell an empty object from an empty array — and its
 * checks therefore accept each where you would expect only the other. That is
 * observable behaviour of the thing being mirrored, so it is reproduced here
 * rather than tidied:
 *
 *   - `"filter": []` reaches the node walk and fails as `node_malformed`
 *     ("missing a string op key"), not as `envelope_malformed`.
 *   - `"args": {}` passes the is-a-list check and fails as
 *     `value_count_mismatch`, not as `node_malformed`.
 *   - `"value": {}` on `in` / `between` does the same.
 *
 * {@link asObject} and {@link asList} are where that lives. Both were verified
 * against the real decoder rather than reasoned about.
 */

import {
  CLOSED_V1,
  FILTER_LIMITS,
  isCompositeOperator,
  isLeafOperator,
  isPresenceOperator,
  isRangeOperator,
  isSetOperator,
  type FieldRef,
  type FilterError,
  type FilterNode,
  type FilterScalar,
  type LeafOperator,
  type ValidationErrorCode,
} from './ast';

export type DecodeResult =
  | { ok: true; filter: FilterNode | null }
  | { ok: false; error: FilterError };

/**
 * Decode a request envelope.
 *
 * `{ ok: true, filter: null }` is the normative **match-all** signal: the
 * envelope carried no `filter` key at all. An explicit `"filter": null` is a
 * different thing and is rejected, because a caller who meant match-all had a
 * way to say so and a caller who sent null probably lost a variable.
 */
export function decodeFilter(raw: string): DecodeResult {
  try {
    return { ok: true, filter: decodeEnvelope(raw) };
  } catch (failure) {
    if (failure instanceof DecodeFailure) return { ok: false, error: failure.error };
    throw failure;
  }
}

function decodeEnvelope(raw: string): FilterNode | null {
  const bytes = byteLength(raw);
  if (bytes > FILTER_LIMITS.maxPayloadBytes) {
    throw fail(
      'value_out_of_bounds',
      ROOT,
      `filter payload ${bytes} bytes exceeds ${FILTER_LIMITS.maxPayloadBytes} bytes`,
      { observed: bytes, limit: FILTER_LIMITS.maxPayloadBytes },
    );
  }

  // Checked before parsing, and on the raw text. The engine cannot distinguish
  // an array root from an object root after decoding — see the file header —
  // so it looks at the first non-whitespace character instead. Reproduced
  // rather than replaced with a JS-native check, because it also decides the
  // error code for a JSON literal, a bare number and a top-level array.
  const trimmed = raw.replace(/^\s+/, '');
  if (trimmed === '' || trimmed[0] !== '{') {
    throw fail('envelope_malformed', ROOT, 'envelope must be a JSON object');
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch (e) {
    throw fail(
      'envelope_malformed',
      ROOT,
      'envelope is not valid JSON: ' + (e instanceof Error ? e.message : String(e)),
    );
  }

  const object = asObject(envelope);
  if (object === null) {
    throw fail('envelope_malformed', ROOT, 'envelope must be a JSON object');
  }

  // Absent is fine; present-and-wrong is not. There is exactly one version.
  if ('version' in object && object.version !== '1') {
    throw fail(
      'version_unsupported',
      child(ROOT, 'version'),
      'unknown filter version; expected "1"',
      { received: scalarish(object.version) },
    );
  }

  if (!('filter' in object)) return null;

  const filter = object.filter;
  const filterPointer = child(ROOT, 'filter');

  if (filter === null) {
    throw fail(
      'node_malformed',
      filterPointer,
      'filter must be an object — use omit-the-key for match-all',
    );
  }

  const root = asObject(filter);
  if (root === null) {
    throw fail('envelope_malformed', filterPointer, 'filter must be a JSON object');
  }

  return decodeNode(root, filterPointer, 1, { nodeCount: 0 });
}

/** The running node total, threaded through the walk. */
interface DecodeContext {
  nodeCount: number;
}

function decodeNode(
  raw: Record<string, unknown>,
  pointer: string[],
  depth: number,
  ctx: DecodeContext,
): FilterNode {
  ctx.nodeCount += 1;
  if (ctx.nodeCount > FILTER_LIMITS.maxNodes) {
    throw fail(
      'node_count_exceeded',
      pointer,
      `filter tree node count exceeds ${FILTER_LIMITS.maxNodes}`,
      { limit: FILTER_LIMITS.maxNodes },
    );
  }
  if (depth > FILTER_LIMITS.maxDepth) {
    throw fail('nesting_too_deep', pointer, `filter tree depth exceeds ${FILTER_LIMITS.maxDepth}`, {
      limit: FILTER_LIMITS.maxDepth,
    });
  }

  const op = raw.op;
  if (typeof op !== 'string') {
    throw fail('node_malformed', pointer, 'node is missing a string "op" key');
  }

  if (op === 'and' || op === 'or') {
    const args = requireCompositeArgs(raw, pointer);
    const children = args.map((arg, i) => {
      const childPointer = child(child(pointer, 'args'), String(i));
      return decodeNode(requireObjectChild(arg, childPointer), childPointer, depth + 1, ctx);
    });
    return { op, args: children };
  }

  if (op === 'not') {
    if (!('arg' in raw)) {
      throw fail('node_malformed', pointer, '"not" node requires singular "arg" child');
    }
    const childPointer = child(pointer, 'arg');
    return {
      op,
      arg: decodeNode(requireObjectChild(raw.arg, childPointer), childPointer, depth + 1, ctx),
    };
  }

  if (isLeafOperator(op)) {
    return decodeLeaf(op, raw, pointer);
  }

  // Composite names are handled above, so anything reaching here is neither a
  // composite nor a closed-v1 leaf. A driver may declare extra operators, but
  // that upgrade happens in pre-flight — the decoder's vocabulary is closed.
  throw fail(
    'operator_unknown',
    child(pointer, 'op'),
    `operator "${op}" is not in the v1 closed set`,
    { received: op },
  );
}

function decodeLeaf(
  op: LeafOperator,
  raw: Record<string, unknown>,
  pointer: string[],
): FilterNode {
  const field = decodeFieldRef(raw, pointer);
  const valuePresent = 'value' in raw;

  if (isPresenceOperator(op)) {
    if (valuePresent) {
      throw fail(
        'value_unexpected',
        child(pointer, 'value'),
        `"${op}" must not carry a value key`,
      );
    }
    return { op, field };
  }

  if (!valuePresent) {
    throw fail('node_malformed', pointer, `"${op}" leaf requires a "value" key`);
  }

  const valuePointer = child(pointer, 'value');
  if (isSetOperator(op)) {
    return { op, field, value: decodeSetValue(op, raw.value, valuePointer) };
  }
  if (isRangeOperator(op)) {
    return { op, field, value: decodeRangeValue(raw.value, valuePointer) };
  }
  return { op, field, value: decodeSingleValue(op, raw.value, valuePointer) };
}

function decodeFieldRef(raw: Record<string, unknown>, pointer: string[]): FieldRef {
  if (!('field' in raw)) {
    throw fail('node_malformed', pointer, 'leaf node is missing required "field" key');
  }
  const fieldPointer = child(pointer, 'field');
  const field = asObject(raw.field);
  if (field === null) {
    throw fail(
      'node_malformed',
      fieldPointer,
      '"field" must be a JSON object with "model" and "name" keys',
    );
  }
  if (typeof field.model !== 'string' || field.model === '') {
    throw fail(
      'node_malformed',
      child(fieldPointer, 'model'),
      '"field.model" must be a non-empty string',
    );
  }
  if (typeof field.name !== 'string' || field.name === '') {
    throw fail(
      'node_malformed',
      child(fieldPointer, 'name'),
      '"field.name" must be a non-empty string',
    );
  }
  return { model: field.model, name: field.name };
}

function decodeSingleValue(op: LeafOperator, value: unknown, pointer: string[]): FilterScalar {
  if (Array.isArray(value)) {
    throw fail('node_malformed', pointer, `"${op}" requires a single scalar value, got an array`);
  }
  if (!isScalar(value)) {
    throw fail(
      'node_malformed',
      pointer,
      `"${op}" requires a scalar value (string, number, or boolean)`,
    );
  }
  if (op === 'prefix') {
    if (typeof value !== 'string') {
      throw fail('node_malformed', pointer, '"prefix" value must be a string');
    }
    if (value === '') {
      throw fail(
        'value_out_of_bounds',
        pointer,
        '"prefix" value must not be empty — omit the filter for match-all',
      );
    }
  }
  if (typeof value === 'string') guardStringLength(value, pointer);
  return value;
}

function decodeSetValue(op: LeafOperator, value: unknown, pointer: string[]): FilterScalar[] {
  const list = asList(value);
  if (list === null) {
    throw fail('node_malformed', pointer, `"${op}" requires a JSON array of scalars`);
  }
  if (list.length === 0) {
    throw fail('value_count_mismatch', pointer, `"${op}" array must contain at least one element`);
  }
  if (list.length > FILTER_LIMITS.maxInElements) {
    throw fail(
      'value_out_of_bounds',
      pointer,
      `"${op}" array length ${list.length} exceeds maximum ${FILTER_LIMITS.maxInElements}`,
      { observed: list.length, limit: FILTER_LIMITS.maxInElements },
    );
  }

  const deduped: FilterScalar[] = [];
  const seen = new Set<string>();
  list.forEach((element, i) => {
    if (!isScalar(element)) {
      throw fail('node_malformed', child(pointer, String(i)), `"${op}" array elements must be scalars`);
    }
    if (typeof element === 'string') guardStringLength(element, child(pointer, String(i)));
    const key = seenKey(element);
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(element);
  });
  return deduped;
}

function decodeRangeValue(value: unknown, pointer: string[]): FilterScalar[] {
  const list = asList(value);
  if (list === null) {
    throw fail('node_malformed', pointer, '"between" requires a 2-element JSON array');
  }
  if (list.length !== 2) {
    throw fail('value_count_mismatch', pointer, '"between" requires exactly two elements', {
      observed: list.length,
    });
  }
  return list.map((element, i) => {
    if (!isScalar(element)) {
      throw fail('node_malformed', child(pointer, String(i)), '"between" elements must be scalars');
    }
    if (typeof element === 'string') guardStringLength(element, child(pointer, String(i)));
    return element;
  });
}

function requireCompositeArgs(raw: Record<string, unknown>, pointer: string[]): unknown[] {
  if (!('args' in raw)) {
    throw fail('node_malformed', pointer, 'composite node requires "args" array');
  }
  const argsPointer = child(pointer, 'args');
  const args = asList(raw.args);
  if (args === null) {
    throw fail('node_malformed', argsPointer, '"args" must be a JSON array');
  }
  if (args.length < 1) {
    throw fail('value_count_mismatch', argsPointer, '"args" must contain at least one child');
  }
  if (args.length > FILTER_LIMITS.maxArgs) {
    throw fail(
      'value_out_of_bounds',
      argsPointer,
      `"args" length ${args.length} exceeds maximum ${FILTER_LIMITS.maxArgs}`,
      { observed: args.length, limit: FILTER_LIMITS.maxArgs },
    );
  }
  return args;
}

function requireObjectChild(value: unknown, pointer: string[]): Record<string, unknown> {
  const object = asObject(value);
  if (object === null) {
    throw fail('node_malformed', pointer, 'child must be a JSON object');
  }
  return object;
}

function guardStringLength(value: string, pointer: string[]): void {
  // Code points, matching the engine's `mb_strlen`. `value.length` is UTF-16
  // code units and would let a 4096-character string of astral characters
  // through as 8192, or reject one the engine accepts.
  const length = [...value].length;
  if (length > FILTER_LIMITS.maxStringLength) {
    throw fail(
      'value_out_of_bounds',
      pointer,
      `string value of length ${length} exceeds maximum ${FILTER_LIMITS.maxStringLength}`,
      { observed: length, limit: FILTER_LIMITS.maxStringLength },
    );
  }
}

/* ------------------------------------------------------------------ *
 * PHP's array model, reproduced where it is observable
 * ------------------------------------------------------------------ */

/**
 * The value as a JSON object, or null.
 *
 * An **empty array is accepted as an empty object**, because in PHP it is one:
 * `json_decode('{}', true)` and `json_decode('[]', true)` both yield `[]`, and
 * the engine's `isAssocArray()` returns true for it explicitly. See the file
 * header for the three places that is observable.
 */
function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  if (Array.isArray(value)) return value.length === 0 ? {} : null;
  return value as Record<string, unknown>;
}

/**
 * The value as a JSON array, or null.
 *
 * The mirror image of {@link asObject}: an **empty object is accepted as an
 * empty list**, because `array_is_list([])` is true for the `[]` that `{}`
 * decodes to.
 */
function asList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && value !== null && Object.keys(value).length === 0) return [];
  return null;
}

function isScalar(value: unknown): value is FilterScalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * The dedup bucket for `in` / `nin`, prefixed by type so that `1` and `"1"` do
 * not collapse into one element.
 *
 * **One divergence lives here and cannot be closed in a browser.** PHP's
 * `gettype()` distinguishes `integer` from `double`, so the engine keeps both
 * elements of `[1, 1.0]`; `JSON.parse` gives JavaScript one number type and
 * `1.0` is `1`, so this collapses them. It is unreachable from the builder,
 * needs a hand-typed literal in the wire pane to provoke, and the alternative
 * — a second parse of the raw text to recover which literals had a decimal
 * point — would be a large amount of machinery for a case with no teaching
 * value.
 */
function seenKey(value: FilterScalar): string {
  if (typeof value === 'boolean') return `boolean:${value ? '1' : '0'}`;
  if (typeof value === 'number') {
    return `${Number.isInteger(value) ? 'integer' : 'double'}:${String(value)}`;
  }
  return `string:${value}`;
}

/** UTF-8 bytes, matching PHP's `strlen()` on the raw request body. */
function byteLength(raw: string): number {
  return new TextEncoder().encode(raw).length;
}

/** Rendered into a rejection's `details`, where only scalars are allowed. */
function scalarish(value: unknown): string | number | boolean | null {
  if (value === null || isScalar(value)) return value;
  return Array.isArray(value) ? 'array' : typeof value;
}

/* ------------------------------------------------------------------ *
 * RFC 6901 pointers, and the fail-fast carrier
 * ------------------------------------------------------------------ */

const ROOT: string[] = [];

function child(pointer: string[], segment: string): string[] {
  return [...pointer, segment];
}

/** RFC 6901 §3: `~` encodes as `~0` and `/` as `~1`. */
export function pointerToString(pointer: string[]): string {
  return pointer.map(s => '/' + s.replace(/~/g, '~0').replace(/\//g, '~1')).join('');
}

/**
 * The internal throw.
 *
 * A class rather than a plain object so the single `catch` in
 * {@link decodeFilter} can tell a decode rejection from a genuine bug in this
 * file — swallowing the second as a validation error would turn a crash into a
 * plausible-looking error message about the visitor's JSON.
 */
class DecodeFailure extends Error {
  constructor(readonly error: FilterError) {
    super(error.message);
    this.name = 'DecodeFailure';
  }
}

function fail(
  errorCode: ValidationErrorCode,
  pointer: string[],
  message: string,
  details?: Record<string, string | number | boolean | null>,
): DecodeFailure {
  return new DecodeFailure({
    errorCode,
    jsonPointer: pointerToString(pointer),
    message,
    ...(details === undefined ? {} : { details }),
  });
}

/** Exported for the builder's operator dropdown, which must not invent one. */
export const DECODABLE_OPERATORS = CLOSED_V1;

/** Exported so a caller can tell a composite apart without importing the tuple. */
export { isCompositeOperator };
