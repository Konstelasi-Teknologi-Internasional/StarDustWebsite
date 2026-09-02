/**
 * One sort key — `src/Read/SortSpec.php`, `SortTarget.php`, `SortDirection.php`.
 *
 * The three targets are a cost boundary rather than a naming convenience:
 *
 *   - `id`         — `entry_data.id`. A range scan on the primary key, or a
 *                    backward index scan for `DESC`. No filesort at any depth.
 *   - `created_at` — ordered by the `(tenant_id, deleted_at, created_at)`
 *                    composite. Also no filesort.
 *   - `field`      — a registered field's indexed slot column, on a joined
 *                    extension page. MySQL builds a temporary table and
 *                    filesorts over the **whole filtered set** to find each
 *                    page, which narrows the bounded-*discovery* guarantee.
 *                    Materialisation stays bounded and the query count stays
 *                    two; the section says so rather than drawing it as free.
 *
 * **Single key by design.** `entry_data.id` is always appended in the same
 * direction as an implicit tiebreak, which is what makes every ordering total
 * and therefore what makes the cursor stable. A second user key is deferred,
 * not forgotten.
 *
 * A `null` sort means `id` ascending — the ordering every read had before
 * ADR 0041, which is why existing callers and existing cursors are unaffected.
 */

export type SortTarget = 'id' | 'created_at' | 'field';
export type SortDirection = 'asc' | 'desc';

export interface SortSpec {
  target: SortTarget;
  /** Set only for `target: 'field'`. */
  fieldName: string | null;
  direction: SortDirection;
}

export function byId(direction: SortDirection = 'asc'): SortSpec {
  return { target: 'id', fieldName: null, direction };
}

export function byCreatedAt(direction: SortDirection = 'asc'): SortSpec {
  return { target: 'created_at', fieldName: null, direction };
}

export function byField(fieldName: string, direction: SortDirection = 'asc'): SortSpec {
  return { target: 'field', fieldName, direction };
}

export function isFieldSort(sort: SortSpec | null): boolean {
  return sort !== null && sort.target === 'field';
}

/**
 * The stable identity of the sort key, independent of direction.
 *
 * Stamped into a v2 cursor so a token replayed against a different ordering is
 * *detected* rather than silently paginating something else — the failure
 * ADR 0006 names but could not detect while there was no sort parameter to
 * compare against.
 *
 * A null sort answers `$id`, which is what makes a v1 token and an explicit
 * ascending id sort name the same ordering.
 */
export function keyIdentity(sort: SortSpec | null): string {
  if (sort === null || sort.target === 'id') return '$id';
  if (sort.target === 'created_at') return '$created_at';
  return `f:${sort.fieldName ?? ''}`;
}

export function directionOf(sort: SortSpec | null): SortDirection {
  return sort === null ? 'asc' : sort.direction;
}

/** `ASC` / `DESC`, interpolated into `ORDER BY` — hence a closed set. */
export function sqlDirection(direction: SortDirection): string {
  return direction === 'asc' ? 'ASC' : 'DESC';
}

/** The keyset comparison for a walk in this direction. */
export function keysetOperator(direction: SortDirection): '>' | '<' {
  return direction === 'asc' ? '>' : '<';
}

/** How the sort reads in a caption: `city DESC`, `entry_data.id ASC`. */
export function describeSort(sort: SortSpec | null): string {
  const direction = sqlDirection(directionOf(sort));
  if (sort === null || sort.target === 'id') return `entry_data.id ${direction}`;
  if (sort.target === 'created_at') return `entry_data.created_at ${direction}`;
  return `${sort.fieldName} ${direction}`;
}
