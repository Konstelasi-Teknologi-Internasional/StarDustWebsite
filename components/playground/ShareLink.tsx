'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  describeRecipe,
  recipeFor,
  toQuery,
  type LinkRecipe,
} from '@/lib/sim/link';
import type { ScenarioId } from '@/lib/sim/scenarios';
import { SITE_URL } from '@/lib/links';
import { usePlayground } from './PlaygroundContext';
import styles from './ShareLink.module.css';

/**
 * Handing this world to somebody else, and being handed one.
 *
 * Three exports for the same reason `ScenarioPicker` has two: they belong on
 * opposite sides of the clock bar's `position: sticky`. {@link ShareButton} is
 * a world control and sits on the bar next to `reset world`; {@link ShareStrip}
 * is a URL long enough to wrap twice and would make the sticky bar tall enough
 * to eat a phone screen, so it renders below and scrolls away with the page.
 *
 * {@link SharedLinkStrip} is the other direction — a link that arrived over a
 * world the visitor had already built. It is an offer rather than an action,
 * on the picker's precedent: a scenario warns before replacing a populated
 * world, and a stranger's link has even less right to replace one silently.
 *
 * None of the three holds the open state. The root does, so `reset world` can
 * close a strip describing a world that no longer exists.
 */

export function ShareButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`btn ${styles.trigger}`}
      onClick={onToggle}
      aria-expanded={open}
      // Only while the panel exists: `aria-controls` pointing at an id that is
      // not in the document is worse than no `aria-controls` at all.
      aria-controls={open ? 'share-strip' : undefined}
      title="A link that rebuilds this world on someone else's screen"
    >
      share
    </button>
  );
}

export function ShareStrip({
  scenarioId,
  stepIndex,
  onDismiss,
}: {
  scenarioId: ScenarioId | null;
  stepIndex: number | null;
  onDismiss: () => void;
}) {
  const { world } = usePlayground();
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { recipe, unseeded, travels } = useMemo(
    () => recipeFor(world, { scenarioId, stepIndex }),
    [world, scenarioId, stepIndex],
  );

  /**
   * The canonical origin, not this tab's.
   *
   * `window.location.origin` reads correctly and produces a link nobody else
   * can open: shared from a dev server it says `localhost:3000`, and the whole
   * point of the button is that the URL leaves this machine. `SITE_URL` is the
   * constant `lib/links.ts` already keeps for exactly this — the one place the
   * domain is stated, because a static export has no request to derive a host
   * from. The *path* still comes from the page, so the route is never
   * hardcoded here and a trailing slash follows whatever the export produced.
   *
   * `window` is read here rather than in `lib/sim/link.ts`, which stays
   * browser-free so `verify:link` can drive it from node. This component is
   * only ever mounted by a click, so it never renders on the server — but the
   * guard is cheap and the static export is unforgiving about the difference.
   */
  const url = useMemo(() => {
    const query = toQuery(recipe);
    if (typeof window === 'undefined') return query;
    return `${SITE_URL}${window.location.pathname}${query}`;
  }, [recipe]);

  // The confirmation is a label change, not a toast. It has to go back on its
  // own or a second copy of a *different* link would look like it did nothing.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  // Copying resets whenever the link changes underneath, which it does on
  // every tick of the clock — a world that has moved on is a different share.
  useEffect(() => setCopied(false), [url]);

  const empty = recipe.step === null && recipe.scenario === null && recipe.models.length === 0;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard access is refused outright in some browsers without a
      // permission prompt, and over plain HTTP in all of them. Selecting the
      // text is the fallback that always works: the visitor presses their own
      // copy shortcut, which is what they would have done anyway.
      inputRef.current?.select();
    }
  }

  return (
    <div className={`panel ${styles.strip}`} id="share-strip" role="group" aria-label="share this world">
      <div className={styles.head}>
        <p className="eyebrow">share</p>
        <button type="button" className={styles.dismiss} onClick={onDismiss}>
          dismiss
        </button>
      </div>

      <div className={styles.body}>
        {empty ? (
          <p className={styles.note}>
            There is nothing to share yet. Define a model, load a scenario, or start the
            guided tour, and this link will rebuild it.
          </p>
        ) : !travels ? (
          // Refusing to show a link beats showing one that decodes to nothing.
          // The recipient of a link past the decoder's caps lands on an empty
          // playground with no way to tell that anything was meant to be there.
          <p className={styles.note}>
            This world is past what a link can carry — too many models, or too many
            fields on one of them. Everything still works here; there is just no URL
            short enough to rebuild it on someone else&apos;s screen.
          </p>
        ) : (
          <>
            <div className={styles.row}>
              <input
                ref={inputRef}
                className={styles.url}
                type="text"
                readOnly
                value={url}
                aria-label="link to this world"
                onFocus={event => event.currentTarget.select()}
              />
              <button type="button" className={`btn ${styles.copy}`} onClick={copy}>
                {copied ? 'copied' : 'copy'}
              </button>
            </div>

            <p className={styles.note}>
              Carries <strong>{describeRecipe(recipe)}</strong>. The link is a recipe, not
              a copy of the database — opening it rebuilds this world by replaying the
              same actions, so it stays short enough to paste anywhere.
            </p>

            {unseeded.length > 0 && (
              <p className={styles.caveat}>
                Rows written by hand cannot travel: {unseeded.join(', ')}{' '}
                {unseeded.length === 1 ? 'arrives' : 'arrive'} with{' '}
                {unseeded.length === 1 ? 'its' : 'their'} schema and no rows. Seeded rows
                are reproduced exactly, because the seed is deterministic.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function SharedLinkStrip({
  recipe,
  onLoad,
  onDismiss,
}: {
  recipe: LinkRecipe;
  onLoad: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className={`panel ${styles.strip}`} role="status">
      <div className={styles.head}>
        <p className="eyebrow">shared link</p>
        <button type="button" className={styles.dismiss} onClick={onDismiss}>
          dismiss
        </button>
      </div>
      <div className={styles.body}>
        <p className={styles.note}>
          Someone shared a world with you: <strong>{describeRecipe(recipe)}</strong>. You
          already have one open, so nothing has changed yet.
        </p>
        <button type="button" className={`btn ${styles.load}`} onClick={onLoad}>
          load it — this replaces your world
        </button>
      </div>
    </div>
  );
}
