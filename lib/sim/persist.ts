'use client';

/**
 * The world, across refreshes.
 *
 * A world that persists can persist a *broken* world, so every read here is
 * defensive and every failure resolves the same way: discard and start clean.
 * There is deliberately no migration path between snapshot versions — the
 * playground has no data worth migrating, and a half-migrated world is exactly
 * the returning-visitor-sees-a-crash failure this guards against.
 *
 * Three ways this legitimately fails, all handled:
 *
 *   1. `localStorage` throws outright — Safari private mode on `setItem`, and
 *      any browser configured to block site data even on read.
 *   2. The snapshot parses but was written by an older shape.
 *   3. The snapshot does not parse at all.
 */

import { emptyWorld, SIM_SCHEMA_VERSION, type SimWorld } from './world';

export const STORAGE_KEY = 'stardust.playground.v1';

export function save(world: SimWorld): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(world));
  } catch {
    // Storage is full, blocked, or unavailable. The world is still perfectly
    // usable in memory for this session, so there is nothing to report.
  }
}

/**
 * Returns the stored world, or `null` when there isn't a usable one.
 *
 * Must never be called during render — the page is a static export, so the
 * server-rendered HTML is built from `emptyWorld()` and reading storage on the
 * first client render is a guaranteed hydration mismatch. Call it from a mount
 * effect.
 */
export function load(): SimWorld | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isWorldish(parsed)) {
      clear();
      return null;
    }
    if (parsed.simVersion !== SIM_SCHEMA_VERSION) {
      clear();
      return null;
    }
    // Nested objects are merged onto their defaults rather than restored
    // wholesale. A top-level member absent from an older snapshot already came
    // back as its default, because the spread only overwrites keys that are
    // present; a member absent from one of these nested objects did not, and came back
    // `undefined` instead — a parsed, version-matched, structurally broken
    // world. That is the shape that crashed section C on render, before the
    // Reset button that would have cleared it could be reached.
    //
    // Spreading a missing source is a no-op (`{ ...undefined }` is `{}`), so
    // this is also safe for a snapshot that lacks the key entirely.
    const base = emptyWorld();
    return {
      ...base,
      ...parsed,
      // The clock never resumes itself on load. A page that starts ticking
      // before the visitor has looked at it is the opposite of the point.
      clock: { ...base.clock, ...parsed.clock, running: false },
      seq: { ...base.seq, ...parsed.seq },
      draft: { ...base.draft, ...parsed.draft },
      payloadDraft: { ...base.payloadDraft, ...parsed.payloadDraft },
      queryDraft: { ...base.queryDraft, ...parsed.queryDraft },
    };
  } catch {
    clear();
    return null;
  }
}

export function clear(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Same as save(): nothing useful to do, and nothing depends on it.
  }
}

/**
 * A cheap structural probe, not a validator.
 *
 * It checks the handful of fields the app touches before anything else could
 * fail, and leans on the version check above for the rest — a snapshot written
 * by this same version is trusted, one written by another is discarded whether
 * or not it looks well-formed.
 */
function isWorldish(value: unknown): value is SimWorld {
  if (typeof value !== 'object' || value === null) return false;
  const w = value as Partial<SimWorld>;
  return (
    typeof w.simVersion === 'number' &&
    typeof w.tenantId === 'number' &&
    typeof w.schemaVersion === 'number' &&
    Array.isArray(w.models) &&
    Array.isArray(w.fields) &&
    Array.isArray(w.pages) &&
    Array.isArray(w.slots) &&
    Array.isArray(w.entries) &&
    Array.isArray(w.events) &&
    typeof w.clock === 'object' &&
    w.clock !== null &&
    typeof w.seq === 'object' &&
    w.seq !== null &&
    typeof w.draft === 'object' &&
    w.draft !== null
  );
}
