'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * Drag-to-insert, on pointer events.
 *
 * Pointer events rather than HTML5 drag-and-drop, which is unusable on touch
 * and effectively inaccessible — and this drives the one section every other
 * section depends on, so excluding people from it excludes them from the
 * whole page.
 *
 * The hook is deliberately an *enhancement*: it never owns the only route to
 * an outcome. Every drop it produces is also reachable from a button, and the
 * caller wires both to the same action. That ordering is what keeps keyboard
 * parity real rather than retrofitted.
 *
 * Mechanics worth knowing:
 *
 * - `setPointerCapture` retargets every subsequent move/up to the element
 *   that received the `pointerdown`, so the handlers all live on that one
 *   element and no window listeners are needed. It also survives the pointer
 *   leaving the element, which a plain `onPointerMove` would not.
 * - Nothing is a drag until the pointer has moved {@link THRESHOLD} pixels,
 *   so a draggable element can still be a plain `<button>` with a plain
 *   `onClick`. That matters more than it looks: a button is activated from
 *   the keyboard by a `click` event, which no amount of pointer handling ever
 *   produces. Keeping `onClick` as the real action is what makes the palette
 *   work for someone who never touches a pointing device.
 * - Because pointer capture makes `click` fire after a drag too, the caller
 *   must gate its `onClick` on {@link DragApi.ignoreClick}, which is true
 *   exactly once after a completed drag.
 * - The grip must carry `touch-action: none` in CSS or the browser claims the
 *   gesture for scrolling and no `pointermove` ever arrives.
 */

/** Pixels of movement before a press becomes a drag rather than a tap. */
const THRESHOLD = 5;

export interface DragState<P> {
  payload: P;
  /** Viewport coordinates, for positioning the ghost. */
  x: number;
  y: number;
  /**
   * Where the payload would land, as an index into the *current* list —
   * 0 is before the first row, `rowCount` is after the last.
   */
  insertIndex: number;
}

interface Options<P> {
  /** How many rows are currently registered. Drives the last valid index. */
  rowCount: number;
  onDrop: (payload: P, insertIndex: number) => void;
}

export function usePointerDrag<P>({ rowCount, onDrop }: Options<P>) {
  const [drag, setDrag] = useState<DragState<P> | null>(null);

  const rows = useRef(new Map<number, HTMLElement>());
  const origin = useRef<{ x: number; y: number } | null>(null);
  const payload = useRef<P | null>(null);
  const moved = useRef(false);
  const suppressClick = useRef(false);

  /** Ref callback for row `index`. Rows must register to be drop targets. */
  const registerRow = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      if (el) rows.current.set(index, el);
      else rows.current.delete(index);
    },
    [],
  );

  /**
   * The insertion point for a given viewport y.
   *
   * A row's midpoint is the boundary: above it the payload goes before that
   * row, below it the search continues. Past every midpoint it goes last.
   */
  const indexForY = useCallback(
    (y: number): number => {
      for (let i = 0; i < rowCount; i++) {
        const el = rows.current.get(i);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (y < rect.top + rect.height / 2) return i;
      }
      return rowCount;
    },
    [rowCount],
  );

  const start = useCallback(
    (item: P) => (e: React.PointerEvent<HTMLElement>) => {
      // Secondary buttons open context menus and must not begin a drag.
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      origin.current = { x: e.clientX, y: e.clientY };
      payload.current = item;
      moved.current = false;
      // Cleared here as well as when it is read: a drag released outside the
      // element may never produce the click that would have consumed it, and
      // a stale flag would swallow the next genuine one.
      suppressClick.current = false;
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const from = origin.current;
      const item = payload.current;
      if (!from || item === null) return;

      if (!moved.current) {
        const far =
          Math.abs(e.clientX - from.x) > THRESHOLD ||
          Math.abs(e.clientY - from.y) > THRESHOLD;
        if (!far) return;
        moved.current = true;
      }

      setDrag({
        payload: item,
        x: e.clientX,
        y: e.clientY,
        insertIndex: indexForY(e.clientY),
      });
    },
    [indexForY],
  );

  const finish = useCallback(() => {
    origin.current = null;
    payload.current = null;
    moved.current = false;
    setDrag(null);
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const item = payload.current;
      if (item === null) return;

      if (moved.current) {
        onDrop(item, indexForY(e.clientY));
        suppressClick.current = true;
      }

      finish();
    },
    [finish, indexForY, onDrop],
  );

  /**
   * A cancelled pointer — the OS took the gesture, or the element was
   * unmounted mid-drag. Abandoning is correct: a cancel is explicitly not a
   * drop, and committing one would reorder a list the visitor let go of.
   */
  const onPointerCancel = useCallback(() => finish(), [finish]);

  /**
   * True exactly once, for the `click` that pointer capture emits after a
   * completed drag. Call it first in the `onClick` the drag shares an element
   * with, and bail when it returns true.
   */
  const ignoreClick = useCallback((): boolean => {
    if (!suppressClick.current) return false;
    suppressClick.current = false;
    return true;
  }, []);

  return {
    drag,
    start,
    registerRow,
    ignoreClick,
    /** Spread onto the same element that `start` was bound to. */
    handlers: { onPointerMove, onPointerUp, onPointerCancel },
  };
}
