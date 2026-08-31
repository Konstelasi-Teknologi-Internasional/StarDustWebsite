'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * True once the element has been on screen. Deliberately latching: the demos
 * are stateful machines, and restarting them every time the user scrolls past
 * would throw away whatever they had set up.
 */
export function useInView<T extends HTMLElement>(margin = '-15% 0px'): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;

    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }

    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) setSeen(true);
      },
      { rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [margin, seen]);

  return [ref, seen];
}
