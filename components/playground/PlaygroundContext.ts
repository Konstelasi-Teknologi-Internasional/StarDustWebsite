'use client';

import { createContext, useContext, type Dispatch } from 'react';
import type { SimAction } from '@/lib/sim/reduce';
import { emptyWorld, type SimWorld } from '@/lib/sim/world';

type PlaygroundValue = {
  world: SimWorld;
  dispatch: Dispatch<SimAction>;
  /**
   * False until the snapshot restore has run. Anything that would differ
   * between the statically-rendered HTML and the restored world must wait for
   * this, or React tears the tree down with a hydration mismatch.
   */
  hydrated: boolean;
};

const PlaygroundContext = createContext<PlaygroundValue>({
  world: emptyWorld(),
  dispatch: () => undefined,
  hydrated: false,
});

export const PlaygroundProvider = PlaygroundContext.Provider;

/**
 * Context rather than props: the sections are views over one world, and the
 * last of them has to see what the first one built. Prop-drilling that through
 * six sections would make the page component the coupling everything else
 * routes around.
 */
export function usePlayground(): PlaygroundValue {
  return useContext(PlaygroundContext);
}
