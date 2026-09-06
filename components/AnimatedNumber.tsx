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
      // Clamped at both ends. A rAF callback is handed the timestamp of the
      // frame it belongs to, which can predate the `performance.now()` read
      // that scheduled it — and an unclamped negative `t` runs easeOutCubic
      // far outside [0,1], which is how a row count rendered as
      // "-544,157,233" instead of counting up to twenty-two million.
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      // easeOutCubic — fast commitment, gentle settle.
      const eased = 1 - Math.pow(1 - t, 3);
      const next = Math.round(a + (value - a) * eased);
      // Every frame, not just the last: a value that changes mid-flight
      // otherwise restarts from where the *previous* run began rather than
      // from the number currently on screen, and the count jumps backwards
      // before it resumes.
      from.current = next;
      setShown(next);
      if (t < 1) raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, reduced]);

  return <>{shown.toLocaleString('en-US')}</>;
}
