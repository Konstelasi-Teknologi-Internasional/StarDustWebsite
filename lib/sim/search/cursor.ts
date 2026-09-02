/**
 * The opaque pagination token — `src/Read/CursorCodec.php` + `CursorPayload.php`.
 *
 * Two wire formats, told apart by a prefix inside the base64url:
 *
 *   - `base64url("v1:" + entryId)` — the original, still emitted for an
 *     unsorted read so tokens issued before sorting existed keep working and
 *     unsorted callers see no change at all.
 *   - `base64url("v2:" + json)` — a sorted read. The JSON carries the anchor
 *     entry id plus the sort key identity and direction.
 *
 * **A v2 token records the ordering but not the anchor row's sort value.** The
 * value is resolved from the anchor row at query time, which keeps the token
 * constant-size — embedding it would make a cursor over a 4096-character
 * string field roughly 22 KB — and keeps ADR 0006's "cursor derived from the
 * id of the last record seen" literally true.
 *
 * The encoding is opaque by contract, not by seal: tampering is detected by
 * structural validation, not authentication. The playground shows the decoded
 * contents beside the token for exactly that reason — there is nothing secret
 * in it, and a visitor who wants to see why changing the sort invalidates a
 * cursor has to be able to look inside.
 */

import { keyIdentity, type SortDirection, type SortSpec } from './sort';

export interface CursorPayload {
  entryId: number;
  /** Null for a v1 token, which predates sorting and means `$id` ascending. */
  sortKeyIdentity: string | null;
  direction: SortDirection | null;
}

export type CursorDecodeResult =
  | { ok: true; payload: CursorPayload }
  | { ok: false; error: string };

/**
 * Encode the next-page token for a read ordered by `sort`.
 *
 * A null sort emits v1, byte-identical to what the engine issued before
 * ADR 0041 — the one case where "do nothing new" is the specification.
 */
export function encodeCursor(sort: SortSpec | null, entryId: number): string {
  if (sort === null) return base64UrlEncode(`v1:${entryId}`);
  return base64UrlEncode(
    'v2:' + JSON.stringify({ k: keyIdentity(sort), d: sort.direction, id: entryId }),
  );
}

export function decodeCursor(token: string): CursorDecodeResult {
  let decoded: string;
  try {
    decoded = base64UrlDecode(token);
  } catch {
    return { ok: false, error: 'Cursor decode failed: not a valid base64url payload.' };
  }

  if (decoded.startsWith('v1:')) {
    const idPart = decoded.slice(3);
    // No signs, no leading zeros, no whitespace — the encode path only ever
    // produces canonical integer strings, so anything else is tampering or a
    // truncated copy-paste rather than an old format.
    if (!/^\d+$/.test(idPart)) {
      return { ok: false, error: 'Cursor decode failed: malformed entry id payload.' };
    }
    return {
      ok: true,
      payload: { entryId: Number(idPart), sortKeyIdentity: null, direction: null },
    };
  }

  if (decoded.startsWith('v2:')) return decodeV2(decoded.slice(3));

  return { ok: false, error: 'Cursor decode failed: missing version prefix.' };
}

function decodeV2(json: string): CursorDecodeResult {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, error: 'Cursor decode failed: malformed v2 payload.' };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, error: 'Cursor decode failed: malformed v2 payload.' };
  }

  const { k, d, id } = data as Record<string, unknown>;
  if (typeof k !== 'string' || k === '' || typeof d !== 'string' || !Number.isInteger(id) || (id as number) < 0) {
    return { ok: false, error: 'Cursor decode failed: malformed v2 payload.' };
  }
  if (d !== 'asc' && d !== 'desc') {
    return { ok: false, error: 'Cursor decode failed: unknown sort direction.' };
  }

  return { ok: true, payload: { entryId: id as number, sortKeyIdentity: k, direction: d } };
}

/**
 * Whether this token was issued for the ordering now being requested.
 *
 * A v1 payload carries no ordering, so it matches the default — both a null
 * sort and an explicit ascending sort on `entry_data.id`, which name the same
 * ordering and must not be reported as a mismatch.
 */
export function matchesSort(payload: CursorPayload, sort: SortSpec | null): boolean {
  return (
    (payload.sortKeyIdentity ?? '$id') === keyIdentity(sort) &&
    (payload.direction ?? 'asc') === (sort === null ? 'asc' : sort.direction)
  );
}

/* ------------------------------------------------------------------ *
 * base64url
 * ------------------------------------------------------------------ */

/**
 * UTF-8 bytes then base64, `+/` swapped for `-_` and the padding trimmed.
 *
 * Byte-oriented rather than `btoa(string)` because a v2 payload embeds a field
 * *name*, and field names are `VARCHAR(128)` holding whatever the tenant
 * typed. `btoa` throws outright on anything above U+00FF, so the obvious
 * one-liner turns a model with an accented field name into a crash on the
 * second page.
 */
function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(token: string): string {
  const binary = atob(token.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
