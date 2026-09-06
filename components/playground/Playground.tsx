'use client';

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import Footer from '@/components/Footer';
import Nav from '@/components/Nav';
import { tickMs } from '@/lib/sim/clock';
import { reduce } from '@/lib/sim/reduce';
import { clear as clearSnapshot, load, save } from '@/lib/sim/persist';
import { scenarioById, type ScenarioId } from '@/lib/sim/scenarios';
import { TOUR, tourStep } from '@/lib/sim/tour';
import { emptyWorld } from '@/lib/sim/world';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { useTicker } from '@/lib/useTicker';
import ClockBar from './ClockBar';
import DaemonRoom from './DaemonRoom';
import EntryWriter from './EntryWriter';
import ModelBuilder from './ModelBuilder';
import NarrationFeed from './NarrationFeed';
import { PlaygroundProvider } from './PlaygroundContext';
import QueryBuilder from './QueryBuilder';
import { ScenarioStrip } from './ScenarioPicker';
import SchemaEvolver from './SchemaEvolver';
import SimulationNotice from './SimulationNotice';
import TableInspector from './TableInspector';
import { TourPanel, TourToggle } from './TourPanel';
import { useNarration } from './useNarration';
import { useSectionVisibility } from './useSectionVisibility';
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

  /**
   * The guided-tour cursor. `null` is the sandbox — every control unlocked,
   * nothing scripted — and a number is the step being shown.
   *
   * Component state rather than a member of `SimWorld`, on the scenario
   * picker's precedent: it has no column behind it, and nothing persists it. A
   * refresh mid-tour therefore lands in the sandbox with the world intact,
   * which is the tour's own ending state rather than a loss.
   */
  const [stepIndex, setStepIndex] = useState<number | null>(null);
  const step = stepIndex === null ? undefined : tourStep(stepIndex);

  // Which sections are on screen, and the milestones the visitor is told
  // about. Both derived — nothing here joins `SimWorld`. The feed stands down
  // while a tour is running; see `TourPanel` for why.
  const visible = useSectionVisibility();
  const { cards, history, dismiss, resync } = useNarration(world, visible, step !== undefined);

  /**
   * Move the cursor: scroll first, then commit.
   *
   * The order is the whole design. A step's actions land in a section four
   * screens from wherever the visitor is standing, so the scroll goes first and
   * the world changes under their eyes rather than behind their back. The copy
   * is written in the past tense to match.
   *
   * Deliberately **no `resync()`**, unlike the two other gestures that replace a
   * world. That call skips a batch outright — cards and history both — and the
   * tour wants only the cards silenced, which the `silenced` input above already
   * does at consume time. Calling it here would hand the visitor an empty drawer
   * at the end of a sixteen-step walk. Entering a tour needs none either: step 1
   * resets, the read position goes backwards, and the hook recognises a
   * different world on its own.
   */
  const goToStep = useCallback(
    (index: number) => {
      const next = tourStep(index);
      if (next === undefined) return;
      setStepIndex(index);
      document.getElementById(next.section)?.scrollIntoView({
        // The site's rule under reduced motion is to arrive rather than travel.
        behavior: reduced ? 'auto' : 'smooth',
        block: 'start',
      });
      dispatch({ type: 'tour/step', index });
    },
    [reduced],
  );

  // Snapshot restore happens after mount, never during render. The page is a
  // static export: its HTML is built from emptyWorld(), and reading
  // localStorage on the first client render would guarantee a hydration
  // mismatch. A stored world is discarded rather than migrated on a version
  // change, so one bad deploy cannot strand a returning visitor on a page
  // that throws.
  useEffect(() => {
    const stored = load();
    if (stored) {
      dispatch({ type: 'world/hydrate', world: stored });
      // A restored world arrives carrying its whole retained log. Without
      // this the feed would greet a returning visitor with two hundred cards
      // about things they did last time. Called only when a world was
      // actually replaced — on a first visit there is nothing to absorb, and
      // absorbing anyway would swallow their first real action.
      resync();
    } else {
      // No snapshot means a first visit, and a first visit opens guided. The
      // scroll is skipped rather than jumping the page on load — step 1 is the
      // first section anyway — and step 1's actions are `world/reset` alone,
      // which is what makes this safe under StrictMode's double-invoked effect.
      setStepIndex(0);
      dispatch({ type: 'tour/step', index: 0 });
    }
    setHydrated(true);
    // `resync` is stable; the restore must run exactly once regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // The tour needs neither: every one of its steps folds its own ticks.
  useTicker(hydrated && world.clock.running && !reduced, tickMs(world.clock), () =>
    dispatch({ type: 'clock/tick' }),
  );

  // Which preset is parked, if any. Deliberately component state rather than a
  // member of `SimWorld`: it has no column behind it, and a reload landing on a
  // parked world with no strip is a correct world, not a broken one.
  const [scenarioId, setScenarioId] = useState<ScenarioId | null>(null);
  const scenario = scenarioId === null ? undefined : scenarioById(scenarioId);

  const onReset = useCallback(() => {
    clearSnapshot();
    dispatch({ type: 'world/reset' });
    // Both describe a world that no longer exists.
    setScenarioId(null);
    setStepIndex(null);
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
            {/* The mode switch, in the slot stage 5.5 left uncommitted when it
                put the scenario picker on the clock bar instead.

                Not gated on `hydrated`, on `NowLine`'s precedent: the reducer
                is seeded with `emptyWorld()` and both the snapshot and the
                opening step arrive from a mount effect, so the first client
                render — the only one hydration compares — already matches the
                static export. Gating it would buy nothing and cost a header
                that shifts under the visitor when hydration lands. The one
                read that does need the restored world, whether it is populated
                enough to warrant a confirm, is guarded inside the component. */}
            <TourToggle
              active={step !== undefined}
              onStart={() => goToStep(0)}
              onExit={() => setStepIndex(null)}
            />
          </header>

          <SimulationNotice />

          {reduced && (
            <p className={styles.reducedNote}>
              Reduced motion is on, so the clock will not run on its own. Use{' '}
              <strong>step</strong> to advance it one tick at a time.
            </p>
          )}

          <ClockBar
            onReset={onReset}
            onScenarioLoaded={id => {
              setScenarioId(id);
              // A scenario replaces the world the tour was walking, so the tour
              // is over — its next step would assert against a world that no
              // longer exists and its copy would describe one nobody saw.
              setStepIndex(null);
              // A scenario replays twenty-odd actions in one commit. Those
              // milestones describe a history the visitor did not watch
              // happen, and a stack of cards about it would bury the strip
              // that explains the world they were just handed. `world/reset`
              // needs no equivalent — the read position goes backwards there,
              // which `useNarration` recognises on its own.
              resync();
            }}
          />

          {scenario !== undefined && (
            <ScenarioStrip scenario={scenario} onDismiss={() => setScenarioId(null)} />
          )}

          <ModelBuilder />

          <TableInspector />

          <EntryWriter />

          <DaemonRoom />

          <QueryBuilder />

          <SchemaEvolver />
        </div>
      </main>
      <Footer />

      {/* Outside the shell: both are `position: fixed`, and nesting them inside
          a scrolling column would only invite a future `overflow` on an
          ancestor to clip them. Rendered after hydration for the same reason
          the scenario buttons are — the static export's HTML is built from
          `emptyWorld()`, which has nothing to narrate and no tour running.

          Exactly one of the two is ever mounted. They occupy the same corner,
          and a tour that has just scrolled you to what it is describing leaves
          the feed nothing true to say. */}
      {hydrated &&
        (step !== undefined && stepIndex !== null ? (
          <TourPanel
            step={step}
            index={stepIndex}
            total={TOUR.length}
            onNext={() => goToStep(stepIndex + 1)}
            onRestart={() => goToStep(0)}
            onExit={() => setStepIndex(null)}
          />
        ) : (
          <NarrationFeed cards={cards} history={history} onDismiss={dismiss} />
        ))}
    </PlaygroundProvider>
  );
}
