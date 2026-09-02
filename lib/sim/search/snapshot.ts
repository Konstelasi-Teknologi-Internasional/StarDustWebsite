/**
 * The schema snapshot a read resolves against — `src/Read/SnapshotEntry.php`.
 *
 * The engine caches this per model behind `stardust_schema_version` (ADR 0015)
 * and every read path resolves through it rather than re-reading the registry
 * per leaf. The simulation has no process to cache in and no query to save, so
 * it rebuilds the snapshot per search; what it keeps is the *shape*, because
 * the shape is what makes the two flags on a field distinguishable.
 *
 * The one thing worth reading twice is {@link SnapshotField.isIndexedNow}. It
 * is not `stardust_fields.is_filterable`, and the gap between them is the whole
 * promotion window:
 *
 *   - `isFilterable` — registry intent, set the instant `promoteFieldToFilterable()`
 *     returned. It says what you asked for.
 *   - `isIndexedNow` — a live slot in `assigned` or `ready`. It says whether a
 *     filter works this second. `backfilling` is live but **not** queryable,
 *     because a half-built index must never answer as though it were complete.
 *
 * It is derived from {@link fieldIndexState}, which is the one shared answer
 * sections A, B, D and E all ask, so the query builder cannot drift from the
 * readout in the daemon room.
 */

import type { DeclaredType } from '../types';
import { fieldIndexState, fieldsOf, liveSlotForField, type SimWorld } from '../world';

export interface SnapshotField {
  fieldId: number;
  name: string;
  declaredType: DeclaredType;
  /** Registry intent. Not a promise that a filter works. */
  isFilterable: boolean;
  /** A live slot in `assigned` or `ready`. This is the one a filter needs. */
  isIndexedNow: boolean;
  /** Populated for any live slot, `backfilling` included. */
  pageId: number | null;
  slotColumn: string | null;
  /** The live slot's status, for the panel that has to explain a rejection. */
  slotStatus: string | null;
}

export interface Snapshot {
  modelId: number;
  modelName: string;
  /** `stardust_schema_version.version` the snapshot was taken at. */
  schemaVersion: number;
  fieldsByName: Record<string, SnapshotField>;
  /** page id → `entry_slots_page_N`, for the compiler's FROM clauses. */
  pageTableNames: Record<number, string>;
}

export function snapshotForModel(world: SimWorld, modelId: number): Snapshot | null {
  const model = world.models.find(m => m.id === modelId && m.deletedAt === null);
  if (model === undefined) return null;

  const fieldsByName: Record<string, SnapshotField> = {};
  for (const field of fieldsOf(world, modelId)) {
    const slot = liveSlotForField(world, field.id);
    fieldsByName[field.name] = {
      fieldId: field.id,
      name: field.name,
      declaredType: field.declaredType,
      isFilterable: field.isFilterable,
      isIndexedNow: fieldIndexState(world, field.id) === 'live',
      pageId: slot?.pageId ?? null,
      slotColumn: slot?.slotColumn ?? null,
      slotStatus: slot?.status ?? null,
    };
  }

  const pageTableNames: Record<number, string> = {};
  for (const page of world.pages) pageTableNames[page.id] = page.tableName;

  return {
    modelId,
    modelName: model.name,
    schemaVersion: world.schemaVersion,
    fieldsByName,
    pageTableNames,
  };
}

export function snapshotField(snapshot: Snapshot, name: string): SnapshotField | null {
  return snapshot.fieldsByName[name] ?? null;
}
