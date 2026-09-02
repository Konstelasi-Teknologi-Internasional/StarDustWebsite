'use client';

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import Footer from '@/components/Footer';
import Nav from '@/components/Nav';
import { tickMs } from '@/lib/sim/clock';
import { reduce } from '@/lib/sim/reduce';
import { clear as clearSnapshot, load, save } from '@/lib/sim/persist';
import { emptyWorld } from '@/lib/sim/world';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { useTicker } from '@/lib/useTicker';
import ClockBar from './ClockBar';
import DaemonRoom from './DaemonRoom';
import EntryWriter from './EntryWriter';
import ModelBuilder from './ModelBuilder';
import { PlaygroundProvider } from './PlaygroundContext';
import SimulationNotice from './SimulationNotice';
import TableInspector from './TableInspector';
import styles from './Playground.module.css';

/**
 * The playground's single stateful root.
 *
 * One `useReducer` over the whole simulated database, provided by context.
 * Sections are views over it — they never hold engine state of their own,
 * because the last section has to be able to change a schema the first one
 * defined, on entries the third one wrote.
 */
export default function Playground() {
  const [world, dispatch] = useReducer(reduce, undefined, emptyWorld);
  const [hydrated, setHydrated] = useState(false);
  const reduced = useReducedMotion();

  // Snapshot restore happens after mount, never during render. The page is a
  // static export: its HTML is built from emptyWorld(), and reading
  // localStorage on the first client render would guarantee a hydration
  // mismatch. A stored world is discarded rather than migrated on a version
  // change, so one bad deploy cannot strand a returning visitor on a page
  // that throws.
  useEffect(() => {
    const stored = load();
    if (stored) dispatch({ type: 'world/hydrate', world: stored });
    setHydrated(true);
  }, []);

  // Persistence is a side effect of the world changing, not part of the
  // reducer — StrictMode double-invokes reducers, and a reducer that wrote to
  // storage would behave differently in development than in production.
  useEffect(() => {
    if (!hydrated) return;
    save(world);
  }, [world, hydrated]);

  // Under reduced motion the clock never runs itself; `step` still works, so
  // the whole walkthrough remains reachable one deliberate tick at a time.
  useTicker(hydrated && world.clock.running && !reduced, tickMs(world.clock), () =>
    dispatch({ type: 'clock/tick' }),
  );

  const onReset = useCallback(() => {
    clearSnapshot();
    dispatch({ type: 'world/reset' });
  }, []);

  const value = useMemo(() => ({ world, dispatch, hydrated }), [world, hydrated]);

  return (
    <PlaygroundProvider value={value}>
      <Nav />
      <main className={styles.main}>
        <div className="shell">
          <header className={styles.head}>
            <p className="eyebrow">playground</p>
            <h1 className={styles.title}>Build a schema, then watch it become MySQL.</h1>
            <p className="section-lede">
              One continuous world. Define a model, write rows into it, stop the daemons
              mid-flight and see the system be honestly incomplete — then let them finish
              and watch the identical query start returning rows.
            </p>
          </header>

          <SimulationNotice />

          {reduced && (
            <p className={styles.reducedNote}>
              Reduced motion is on, so the clock will not run on its own. Use{' '}
              <strong>step</strong> to advance it one tick at a time.
            </p>
          )}

          <ClockBar onReset={onReset} />

          <ModelBuilder />

          <TableInspector />

          <EntryWriter />

          <DaemonRoom />
        </div>
      </main>
      <Footer />
    </PlaygroundProvider>
  );
}
