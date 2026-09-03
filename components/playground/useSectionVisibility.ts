'use client';

import { useEffect, useState } from 'react';
import { FEED_SECTIONS, type FeedSection } from '@/lib/sim/notify';

/** Nothing is on screen until the observer has said otherwise. */
function noneVisible(): Record<FeedSection, boolean> {
  return {
    define: false,
    tables: false,
    write: false,
    daemons: false,
    query: false,
  };
}

/**
 * Which sections are on screen **right now**.
 *
 * A second hook rather than a flag on `lib/useInView.ts`, and deliberately so.
 * That one *latches* — it answers "has this ever been on screen", and its
 * docblock says why it must keep doing that: the landing page's four demos are
 * stateful machines, and un-latching it would have a scroll-past throw away
 * whatever a visitor had set up. Widening it to serve this would thread a new
 * branch through four shipped components that do not want one.
 *
 * The five anchors are looked up by `id`. That is not a shortcut around refs:
 * those ids are already a public contract — `ScenarioStrip` jump-links to
 * them, `notify.ts` names them in a closed union, and every section module
 * carries a `scroll-margin-top` so the landing clears the fixed nav. Reaching
 * for them by name here costs five components no props they would otherwise
 * never need. All five render unconditionally from `Playground`, so they exist
 * by the time this effect runs.
 *
 * The margin is what makes "on screen" mean *usefully* on screen. A section
 * here can be several viewports tall, and one intersecting pixel at the far
 * edge is not the visitor looking at it.
 */
export function useSectionVisibility(): Record<FeedSection, boolean> {
  const [visible, setVisible] = useState<Record<FeedSection, boolean>>(noneVisible);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      entries => {
        setVisible(prev => {
          let changed = false;
          const next = { ...prev };

          for (const entry of entries) {
            const id = entry.target.id as FeedSection;
            if (!FEED_SECTIONS.includes(id)) continue;
            if (next[id] !== entry.isIntersecting) {
              next[id] = entry.isIntersecting;
              changed = true;
            }
          }

          // Returning `prev` unchanged keeps a scroll that crosses no boundary
          // from re-rendering the whole page — this fires continuously.
          return changed ? next : prev;
        });
      },
      { rootMargin: '-12% 0px -12% 0px' },
    );

    for (const id of FEED_SECTIONS) {
      const el = document.getElementById(id);
      if (el !== null) observer.observe(el);
    }

    return () => observer.disconnect();
  }, []);

  return visible;
}
