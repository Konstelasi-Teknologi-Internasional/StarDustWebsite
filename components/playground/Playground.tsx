'use client';

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import Footer from '@/components/Footer';
import Nav from '@/components/Nav';
import { useTranslations } from '@/lib/i18n';
import { tickMs } from '@/lib/sim/clock';
import { fromQuery, type LinkRecipe } from '@/lib/sim/link';
import type { FeedSection } from '@/lib/sim/notify';
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
import { ShareStrip, SharedLinkStrip } from './ShareLink';
import SimulationNotice from './SimulationNotice';
import TableInspector from './TableInspector';
import { TourPanel, TourToggle } from './TourPanel';
import { useNarration } from './useNarration';
import { useSectionVisibility } from './useSectionVisibility';
import styles from './Playground.module.css';

/**
 * Scroll to a section and hand it keyboard focus, for both gestures that land
 * a visitor somewhere specific — a tour step and a shared link's `?step=`.
 *
 * Each of the six `<section>` elements carries `tabIndex={-1}`: not in the
 * tab order on its own, but focusable from here, so `aria-labelledby`
 * announces the section a keyboard or screen-reader visitor was just taken
 * to, and the very next Tab reaches that section's own controls rather than
 * whatever the document order would have offered instead — which, standing
 * at the fixed dock, is nothing this section owns at all.
 *
 * `preventScroll: true` because the scroll above is already doing the
 * moving, in whichever mode `reduced` calls for; a plain `.focus()` would
 * jump the viewport a second time and fight the smooth scroll mid-flight.
 */
function goToSection(section: FeedSection, reduced: boolean): void {
  const el = document.getElementById(section);
  el?.scrollIntoView({
    behavior: reduced ? 'auto' : 'smooth',
    block: 'start',
  });
  el?.focus({ preventScroll: true });
}

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
  const t = useTranslations('playground');

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

  // Which preset is parked, if any. Deliberately component state rather than a
  // member of `SimWorld`: it has no column behind it, and a reload landing on a
  // parked world with no strip is a correct world, not a broken one.
  //
  // It sits up here beside the tour cursor rather than below the effects, where
  // it used to, because `applyRecipe` writes both and has to be declared before
  // the mount effect that calls it.
  const [scenarioId, setScenarioId] = useState<ScenarioId | null>(null);
  const scenario = scenarioId === null ? undefined : scenarioById(scenarioId);

  /** Whether the share panel is open. The bar holds the button, not the state. */
  const [shareOpen, setShareOpen] = useState(false);

  /**
   * A link that arrived over a world the visitor had already built.
   *
   * Held rather than applied, on the scenario picker's precedent: replacing a
   * populated world is a gesture that gets confirmed, and a link somebody else
   * wrote has less claim on it than a button on this page does.
   */
  const [pendingLink, setPendingLink] = useState<LinkRecipe | null>(null);

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
      // The site's rule under reduced motion is to arrive rather than travel.
      goToSection(next.section, reduced);
      dispatch({ type: 'tour/step', index });
    },
    [reduced],
  );

  /**
   * Apply a shared link: fold its recipe, then put the cursor where it says.
   *
   * One dispatch rather than one per replayed action, on `scenario/load`'s
   * precedent — one gesture is one commit and one snapshot save. Both cursors
   * are set from the recipe rather than cleared, because a link is exactly one
   * of three things and two of them *are* a cursor position.
   *
   * `resync()` for the reason a scenario needs it: the fold produces a whole
   * history in a single commit, and a stack of cards about things the visitor
   * did not watch happen would bury the world they were just handed.
   *
   * **Idempotent, which is what makes it safe in a mount effect.** Every recipe
   * replays from `world/reset`, so StrictMode's double-invoke lands on the same
   * world the first pass produced.
   */
  const applyRecipe = useCallback(
    (recipe: LinkRecipe) => {
      dispatch({ type: 'link/load', recipe });
      setScenarioId(recipe.scenario);
      setStepIndex(recipe.step);
      setPendingLink(null);
      resync();

      if (recipe.step !== null) {
        const landing = tourStep(recipe.step);
        if (landing !== undefined) {
          // The site's rule under reduced motion is to arrive rather than
          // travel, the same call `goToStep` makes.
          goToSection(landing.section, reduced);
        }
      }
    },
    [reduced, resync],
  );

  // Snapshot restore happens after mount, never during render. The page is a
  // static export: its HTML is built from emptyWorld(), and reading
  // localStorage on the first client render would guarantee a hydration
  // mismatch. A stored world is discarded rather than migrated on a version
  // change, so one bad deploy cannot strand a returning visitor on a page
  // that throws.
  useEffect(() => {
    // A link beats a snapshot: arriving on a URL somebody sent is a more
    // specific intent than coming back to what you had. `fromQuery` discards
    // anything it cannot vouch for whole, so a mangled link reads as no link
    // and the two branches below behave exactly as they did before it existed.
    const shared = fromQuery(window.location.search);
    const stored = load();
    // Un-populated covers both no snapshot and an empty one; a visitor with
    // nothing on screen has nothing to lose and gets the link applied outright.
    const populated = stored !== null && (stored.models.length > 0 || stored.entries.length > 0);

    if (shared !== null && !populated) {
      applyRecipe(shared);
    } else if (shared !== null && stored !== null) {
      // Their world stays, the link waits. `SharedLinkStrip` is the offer.
      dispatch({ type: 'world/hydrate', world: stored });
      resync();
      setPendingLink(shared);
    } else if (stored) {
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
    // `resync` and `applyRecipe` are stable; the restore must run exactly once
    // regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Take the link out of the address bar once it has been read.
   *
   * A separate effect on purpose, and it must not be folded into the one above:
   * stripping the query there would make StrictMode's second invoke see a
   * different URL from the first and take a different branch — hydrating a
   * stored world over the link it had just applied.
   *
   * Consumed on arrival rather than on load, even while an offer is pending.
   * The alternative keeps the link copyable, at the price of replaying it over
   * whatever the visitor builds next every time they refresh, which is the
   * worse of the two failures: the share panel can regenerate a link for any
   * world at any time, and a silently reverted afternoon cannot be undone.
   */
  useEffect(() => {
    if (!hydrated || window.location.search === '') return;
    // The hash is kept: `trailingSlash: true` means the path already ends in a
    // slash, and a hand-authored `?step=6#query` would otherwise lose the
    // anchor along with the parameter that was the thing being consumed.
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  }, [hydrated]);

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

  const onReset = useCallback(() => {
    clearSnapshot();
    dispatch({ type: 'world/reset' });
    // All of these describe a world that no longer exists.
    setShareOpen(false);
    setPendingLink(null);
    setScenarioId(null);
    setStepIndex(null);
  }, []);

  const value = useMemo(() => ({ world, dispatch, hydrated }), [world, hydrated]);

  return (
    <PlaygroundProvider value={value}>
      <Nav />
      <main id="main" className={styles.main}>
        <div className="shell">
          <header className={styles.head}>
            <p className="eyebrow">{t('header.eyebrow')}</p>
            <h1 className={styles.title}>{t('header.title')}</h1>
            <p className="section-lede">{t('header.lede')}</p>
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
              {t('header.reducedBefore')}
              <strong>{t('clockBar.step')}</strong>
              {t('header.reducedAfter')}
            </p>
          )}

          <ClockBar
            onReset={onReset}
            shareOpen={shareOpen}
            onToggleShare={() => setShareOpen(open => !open)}
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
              // The open panel described the world this just replaced.
              setShareOpen(false);
            }}
          />

          {/* Three strips, one slot, and they cannot collide: a link is only
              pending before it has been applied, and applying it is what sets
              the scenario. Each renders below the sticky bar rather than on it,
              for the reason `ScenarioPicker` splits into two exports. */}
          {hydrated && pendingLink !== null && (
            <SharedLinkStrip
              recipe={pendingLink}
              onLoad={() => applyRecipe(pendingLink)}
              onDismiss={() => setPendingLink(null)}
            />
          )}

          {hydrated && shareOpen && (
            <ShareStrip
              scenarioId={scenarioId}
              stepIndex={stepIndex}
              onDismiss={() => setShareOpen(false)}
            />
          )}

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

      {/* On a phone the fixed dock spans the width and sits over whatever the
          scroll position lands on last — without this, the bottom of
          `Footer` is permanently covered by whichever of `TourPanel` or
          `NarrationFeed` is mounted, because a `position: fixed` panel covers
          the same viewport rows no matter how far the document scrolls.
          `--dock-h` is published by whichever one is actually on screen; zero
          otherwise, and above the breakpoint where the dock doesn't span full
          width, the rule below does nothing at all. */}
      <div aria-hidden="true" className={styles.dockGutter} />

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
