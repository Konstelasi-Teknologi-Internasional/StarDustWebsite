'use client';

import { useEffect, useState } from 'react';

/**
 * The demos are the argument, so they still *run* under reduced motion —
 * they just jump between states instead of tweening, and the ambient
 * starfield stops entirely.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  return reduced;
}
