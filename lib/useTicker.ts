'use client';

import { useEffect, useRef } from 'react';

/**
 * setInterval that survives re-renders without restarting, and stays off
 * until `active`. Every demo drives its state machine from one of these
 * rather than from a rAF loop — the animations are CSS transitions between
 * discrete engine states, not per-frame drawing.
 */
export function useTicker(active: boolean, ms: number, fn: () => void) {
  const saved = useRef(fn);
  saved.current = fn;

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [active, ms]);
}
