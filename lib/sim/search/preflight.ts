/**
 * Pre-flight — `src/Search/PreFlight/`, four visitors in a fixed order.
 *
 * This is where the decoder's "is this document well-formed" stops and "does
 * this filter mean anything against *your* schema, on *this* driver" starts.
 * It owns the remaining four of the thirteen codes, and it is the only place
 * in the section that reads the world.
 *
 * The order is the engine's and is load-bearing: every leaf is resolved before
 * any capability is checked, and every capability before any value is typed.
 * So an unknown field anywhere in the tree is reported ahead of a type
 * mismatch elsewhere — one visitor completes over the whole tree before the
 * next begins, rather than the three running per leaf.
 *
 * **Three of the four rejections are not `QueryFilterValidationException`.**
 * The taxonomy names a code for each, but the engine raises the pre-existing
 * Phase 4 exception classes — `UnknownFieldException`,
 * `FieldNotFilterableException`, `FieldNotSortableException`,
 * `InvalidCursorException` — and only `capability_unsupported` carries the
 * discriminator. The rejection shape below records both, because the panel
 * shows the exception a consumer would actually catch *and* the code the
 * blueprint assigns.
 */

import type { FilterNode, LeafNode, ValidationErrorCode } from '../filter/ast';
import { FILTER_LIMITS, CLOSED_V1, isLeaf, isPresenceOperator } from '../filter/ast';
import { debugType } from '../write';
import { decodeCursor, matchesSort } from './cursor';
import { snapshotField, type Snapshot, type SnapshotField } from './snapshot';
import { keyIdentity, type SortSpec } from './sort';

/**
 * ADR 0020 `reason` values, not event names.
 *
 * ADR 0041 added the three sort reasons deliberately as `reason` values so the
 * closed event vocabulary did not have to change — `pre_flight_rejected`
 * carries all of them.
 */
export type RejectionReason =
  | 'field_unknown'
  | 'field_not_filterable'
  | 'value_type_mismatch'
  | 'value_out_of_bounds'
  | 'capability_unsupported'
  | 'sort_field_unknown'
  | 'sort_field_not_sortable'
  | 'cursor_sort_mismatch';

export interface PreFlightRejection {
  /** The exception class a consumer catches. */
  exception:
    | 'UnknownFieldException'
    | 'FieldNotFilterableException'
    | 'FieldNotSortableException'
    | 'InvalidCursorException'
    | 'QueryFilterValidationException';
  message: string;
  /** The taxonomy code the blueprint assigns, whether or not it is thrown. */
  errorCode: ValidationErrorCode;
  reason: RejectionReason;
  /** `field_name` on the log line. For a cursor mismatch, the sort identity. */
  fieldName: string;
  /**
   * The operator, for the `capability_unsupported` line only.
   *
   * Carried rather than recovered from {@link message}: ADR 0020 puts
   * `operator` on that event as its own field, and parsing it back out of a
   * sentence would make the log line depend on the wording of an exception.
   */
  operator?: string;
  /**
   * `capability_unsupported` is deliberately its own event rather than another
   * `pre_flight_rejected` reason, so an operator can metric "a consumer asked
   * for a feature this driver does not service" on its own.
   */
  event: 'pre_flight_rejected' | 'capability_unsupported';
}

export type PreFlightResult = { ok: true } | { ok: false; rejection: PreFlightRejection };

const PASS: PreFlightResult = { ok: true };

/* ------------------------------------------------------------------ *
 * The driver's capabilities (MysqlNativeDriver)
 * ------------------------------------------------------------------ */

/**
 * `supportedOperators()`.
 *
 * The MySQL driver services the whole closed set, so `capability_unsupported`
 * is **unreachable in the playground** — there is no second driver to be
 * narrower. The check exists anyway because ADR 0022 puts operator support on
 * the driver rather than in the pipeline, and a pipeline that skipped it would
 * be modelling a different architecture. It is documented as unreachable
 * rather than removed, and rather than faked.
 */
export const SUPPORTED_OPERATORS: readonly string[] = CLOSED_V1;

/**
 * `supportsFilterOn()` and `supportsSortOn()`.
 *
 * Two questions, one answer on MySQL — both reduce to "the field has a live
 * indexed slot". ADR 0022 keeps them separate methods because an external
 * engine may index a field for matching without keeping it orderable, and that
 * judgement belongs to the driver. Mirrored as two functions for the same
 * reason, even though one delegates to the other.
 */
export function supportsFilterOn(field: SnapshotField): boolean {
  return field.isIndexedNow;
}

export function supportsSortOn(field: SnapshotField): boolean {
  return supportsFilterOn(field);
}

/* ------------------------------------------------------------------ *
 * The pipeline
 * ------------------------------------------------------------------ */

/**
 * Visitors 1–3, over the whole tree, in order.
 *
 * Returns the first rejection or nothing. It does not rewrite the tree the way
 * the engine's `FieldRefResolver` does — the engine threads a resolved
 * descriptor onto every leaf so the compiler can read `pageId` off it, and the
 * simulation's compiler holds the snapshot instead, which is the same
 * information reached one indirection later.
 */
export function preFlightFilter(filter: FilterNode, snapshot: Snapshot): PreFlightResult {
  const leaves = allLeaves(filter);

  for (const leaf of leaves) {
    const field = snapshotField(snapshot, leaf.field.name);
    if (field === null) {
      return reject({
        exception: 'UnknownFieldException',
        message: `filter references unknown field '${leaf.field.name}' for model ${snapshot.modelId}.`,
        errorCode: 'field_unknown',
        reason: 'field_unknown',
        fieldName: leaf.field.name,
        event: 'pre_flight_rejected',
      });
    }
  }

  for (const leaf of leaves) {
    // Non-null: the loop above returned on the first unresolved leaf.
    const field = snapshotField(snapshot, leaf.field.name) as SnapshotField;

    if (!SUPPORTED_OPERATORS.includes(leaf.op)) {
      return reject({
        exception: 'QueryFilterValidationException',
        message: `active driver does not support operator '${leaf.op}'`,
        errorCode: 'capability_unsupported',
        reason: 'capability_unsupported',
        fieldName: leaf.field.name,
        operator: leaf.op,
        event: 'capability_unsupported',
      });
    }

    if (!supportsFilterOn(field)) {
      return reject({
        exception: 'FieldNotFilterableException',
        message: `Field '${leaf.field.name}' is not filterable on the active driver.`,
        errorCode: 'field_not_filterable',
        reason: 'field_not_filterable',
        fieldName: leaf.field.name,
        event: 'pre_flight_rejected',
      });
    }
  }

  for (const leaf of leaves) {
    const field = snapshotField(snapshot, leaf.field.name) as SnapshotField;
    const rejection = validateLeafValues(leaf, field);
    if (rejection !== null) return { ok: false, rejection };
  }

  return PASS;
}

/**
 * Visitor 4 — the sort and the cursor.
 *
 * A separate entry point rather than a fourth call inside the filter pipeline,
 * because a sort is not part of the filter tree and has to be checked when
 * there is no filter at all. The cursor half runs **even when the sort is
 * null**: a v2 token replayed against an unsorted read is just as much a
 * mismatch as the reverse, and silently walking a different ordering is the
 * failure this check exists to prevent.
 */
export function preFlightSort(
  sort: SortSpec | null,
  cursorToken: string | null,
  snapshot: Snapshot,
): PreFlightResult {
  if (sort !== null && sort.target === 'field') {
    const name = sort.fieldName ?? '';
    const field = snapshotField(snapshot, name);
    if (field === null) {
      return reject({
        exception: 'UnknownFieldException',
        message: `Sort target '${name}' is not a registered field of this model.`,
        errorCode: 'field_unknown',
        reason: 'sort_field_unknown',
        fieldName: name,
        event: 'pre_flight_rejected',
      });
    }
    if (!supportsSortOn(field)) {
      return reject({
        exception: 'FieldNotSortableException',
        message: `Field '${name}' is not sortable on the active driver.`,
        errorCode: 'field_not_filterable',
        reason: 'sort_field_not_sortable',
        fieldName: name,
        event: 'pre_flight_rejected',
      });
    }
  }

  if (cursorToken !== null) {
    const decoded = decodeCursor(cursorToken);
    if (!decoded.ok) {
      // A structurally malformed token and one issued for another ordering
      // raise the same class in the engine, because both mean "restart
      // pagination" and separating them would offer the consumer a choice it
      // cannot act on.
      return reject({
        exception: 'InvalidCursorException',
        message: decoded.error,
        errorCode: 'value_out_of_bounds',
        reason: 'cursor_sort_mismatch',
        fieldName: keyIdentity(sort),
        event: 'pre_flight_rejected',
      });
    }
    if (!matchesSort(decoded.payload, sort)) {
      return reject({
        exception: 'InvalidCursorException',
        message:
          'Cursor was issued for a different sort order; restart pagination from the' +
          ' first page after changing the sort.',
        errorCode: 'value_out_of_bounds',
        reason: 'cursor_sort_mismatch',
        fieldName: keyIdentity(sort),
        event: 'pre_flight_rejected',
      });
    }
  }

  return PASS;
}

/* ------------------------------------------------------------------ *
 * Visitor 3 — typed values
 * ------------------------------------------------------------------ */

/**
 * Per-leaf `declared_type` enforcement.
 *
 * **Nothing is coerced here, and that asymmetry with the write path is
 * deliberate in the engine.** `{"qty": "42"}` written against an `int` field
 * is accepted and coerced into the slot; `{"op": "eq", "field": …, "value":
 * "42"}` against the same field is `value_type_mismatch`. A rejected filter
 * loses nothing, while a rejected write loses data — so the write path
 * converges and the read path refuses.
 */
function validateLeafValues(leaf: LeafNode, field: SnapshotField): PreFlightRejection | null {
  if (isPresenceOperator(leaf.op)) return null;
  const value = leaf.value;
  if (value === undefined) return null;

  const elements = Array.isArray(value) ? value : [value];
  for (const element of elements) {
    const rejection = validateElement(element, field, leaf);
    if (rejection !== null) return rejection;
  }
  return null;
}

function validateElement(
  value: unknown,
  field: SnapshotField,
  leaf: LeafNode,
): PreFlightRejection | null {
  switch (field.declaredType) {
    case 'string':
      return validateString(value, field, leaf);
    case 'int':
      return validateInt(value, field, leaf);
    case 'numeric':
      return validateNumeric(value, field, leaf);
    case 'datetime':
      return validateDatetime(value, field, leaf);
  }
}

function validateString(
  value: unknown,
  field: SnapshotField,
  leaf: LeafNode,
): PreFlightRejection | null {
  if (typeof value !== 'string') return typeMismatch(leaf, 'string', value);
  // Code points, matching `mb_strlen` — the same count the write path uses.
  const length = [...value].length;
  if (length > FILTER_LIMITS.maxStringLength) {
    return outOfBounds(
      leaf,
      `string value length ${length} exceeds maximum ${FILTER_LIMITS.maxStringLength}`,
    );
  }
  return null;
}

/** The signed 64-bit range a BIGINT slot column can hold. */
const INT64_MIN = -(2 ** 63);
const INT64_MAX = 2 ** 63 - 1;

function validateInt(
  value: unknown,
  field: SnapshotField,
  leaf: LeafNode,
): PreFlightRejection | null {
  if (typeof value !== 'number') return typeMismatch(leaf, 'int', value);
  // PHP splits this in two — an `is_int` value is in range by construction and
  // only a float is range-checked. JavaScript has one numeric type, so the
  // integrality test does the first half's work and the range test the
  // second's; the accept/reject boundary is the same.
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return typeMismatch(leaf, 'int', value);
  }
  if (value < INT64_MIN || value > INT64_MAX) {
    return outOfBounds(leaf, 'int value out of signed 64-bit range');
  }
  return null;
}

function validateNumeric(
  value: unknown,
  field: SnapshotField,
  leaf: LeafNode,
): PreFlightRejection | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return typeMismatch(leaf, 'numeric', value);
  }
  return null;
}

/**
 * RFC 3339 **with an explicit offset**, then a real calendar instant.
 *
 * A naive datetime is rejected: the engine will not guess a zone for a value
 * it is about to compare against UTC-stored data. This is stricter than the
 * write path, which accepts `Y-m-d H:i:s` — and the difference is not an
 * inconsistency, it is the same rule as the coercion asymmetry above.
 */
const RFC3339_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function validateDatetime(
  value: unknown,
  field: SnapshotField,
  leaf: LeafNode,
): PreFlightRejection | null {
  if (typeof value !== 'string') return typeMismatch(leaf, 'datetime', value);
  if (!RFC3339_WITH_OFFSET.test(value)) return typeMismatch(leaf, 'datetime', value);
  // The pattern is syntax; this is the calendar. `2026-13-01T00:00:00Z` passes
  // the first and fails here, exactly as the engine's round-trip through
  // DateTimeImmutable does.
  if (Number.isNaN(Date.parse(value))) return typeMismatch(leaf, 'datetime', value);
  return null;
}

function typeMismatch(leaf: LeafNode, expected: string, received: unknown): PreFlightRejection {
  return {
    exception: 'QueryFilterValidationException',
    message: `field '${leaf.field.name}' expects ${expected}, received ${debugType(received)}`,
    errorCode: 'value_type_mismatch',
    reason: 'value_type_mismatch',
    fieldName: leaf.field.name,
    event: 'pre_flight_rejected',
  };
}

function outOfBounds(leaf: LeafNode, message: string): PreFlightRejection {
  return {
    exception: 'QueryFilterValidationException',
    message,
    errorCode: 'value_out_of_bounds',
    reason: 'value_out_of_bounds',
    fieldName: leaf.field.name,
    event: 'pre_flight_rejected',
  };
}

function reject(rejection: PreFlightRejection): PreFlightResult {
  return { ok: false, rejection };
}

/** Every leaf of the tree, in document order. */
export function allLeaves(node: FilterNode): LeafNode[] {
  if (isLeaf(node)) return [node];
  if (node.op === 'not') return allLeaves(node.arg);
  return node.args.flatMap(allLeaves);
}
