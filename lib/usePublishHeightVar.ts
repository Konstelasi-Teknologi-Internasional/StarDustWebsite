'use client';

import { useLayoutEffect, type RefObject } from 'react';

/**
 * Publish an element's real height as a CSS custom property on the document
 * root, re-measuring on every cause of it changing — content wrapping, a
 * viewport resize, the element mounting or unmounting.
 *
 * `ClockBar`'s `--clockbar-h` set the precedent this generalises: a fixed or
 * sticky element's true height belongs in a variable, not a guessed pixel
 * number copy-pasted into every downstream `.module.css` that has to clear
 * it. This version additionally resets the variable to `0px` on unmount —
 * `ClockBar` never needs that, because it never unmounts, but `TourPanel` and
 * `NarrationFeed` occupy the same corner and only one of them is ever
 * mounted, so whichever one just left has to stop claiming space for a panel
 * that is no longer there.
 *
 * `useLayoutEffect`, not `useEffect`, for the same reason `ClockBar` gives:
 * it has to land before the browser paints, or whatever reads the variable
 * renders one frame at the stale value and visibly jumps.
 */
export function usePublishHeightVar(ref: RefObject<HTMLElement | null>, varName: string): void {
  // `ref.current` in the dependency array, not just `ref` — `TourPanel` is a
  // stable mount (the ternary in `Playground` swaps the whole component), but
  // `NarrationFeed` toggles its own subtree between the dock and `null` while
  // staying mounted (`cards.length === 0 && history.length === 0` returns
  // early), so the *node this ref points at* changes on renders the effect
  // would otherwise never re-run for. React commits ref attachment before a
  // layout effect fires, so reading it here reflects the render that just
  // landed — the callback-ref alternative for exactly this case.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === 'undefined') {
      document.documentElement.style.setProperty(varName, '0px');
      return;
    }

    const publish = () => {
      document.documentElement.style.setProperty(varName, `${el.offsetHeight}px`);
    };

    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      document.documentElement.style.setProperty(varName, '0px');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.current, varName]);
}
