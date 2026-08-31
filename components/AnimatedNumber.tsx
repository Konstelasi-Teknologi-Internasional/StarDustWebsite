'use client';

import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '@/lib/useReducedMotion';

/** Counts from the previous value to the next one so a jump reads as growth. */
export default function AnimatedNumber({ value, duration = 620 }: { value: number; duration?: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      from.current = value;
      setShown(value);
      return;
    }

    const start = performance.now();
    const a = from.current;
    let raf = 0;

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // easeOutCubic — fast commitment, gentle settle.
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(Math.round(a + (value - a) * eased));
      if (t < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, reduced]);

  return <>{shown.toLocaleString('en-US')}</>;
}
