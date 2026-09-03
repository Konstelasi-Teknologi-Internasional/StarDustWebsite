'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  coalesce,
  milestonesSince,
  readPosition,
  type CoalescedMilestone,
  type FeedSection,
} from '@/lib/sim/notify';
import type { SimWorld } from '@/lib/sim/world';
import { useReducedMotion } from '@/lib/useReducedMotion';

/** How many cards are on screen at once. Beyond this they fall into history. */
const MAX_CARDS = 3;

/** How much the drawer keeps. The full record is section D's event log. */
const MAX_HISTORY = 20;

/** How long a card stays before it retires itself, in ms. */
const CARD_TTL = 9000;

export interface FeedCard extends CoalescedMilestone {
  /** Wall-clock arrival, for the retirement timer. Never rendered. */
  shownAt: number;
}

export interface Narration {
  /** On screen now, newest last. */
  cards: FeedCard[];
  /** Everything that has happened since the last resync, newest first. */
  history: FeedCard[];
  dismiss(seq: number): void;
  /**
   * Adopt whatever arrives next without narrating it.
   *
   * For the two gestures that *replace* the world rather than advance it:
   * restoring a snapshot, and loading a scenario. Both arrive as a burst of
   * lines describing a history the visitor did not watch happen — two hundred
   * cards for a page they just opened, or twenty that bury the very strip
   * explaining the world they were just handed.
   *
   * It sets a flag rather than a position, because the caller cannot know the
   * new position: it runs in a click handler, strictly before the render whose
   * effects would consume the batch. "Skip the next one" is expressible there;
   * "skip up to seq 412" is not.
   */
  resync(): void;
}

/**
 * Fold a new batch into the cards already on screen.
 *
 * `coalesce()` merges within one commit, which is not enough on its own:
 * writing entries one at a time is one commit *each*, so ten writes are ten
 * separate batches and the visitor would watch three identical cards shove
 * each other out. This is the same collapse continued across commits, and it
 * belongs here rather than in `notify.ts` because it is a fact about what is
 * currently on screen rather than about the stream.
 *
 * The existing card keeps its `seq` and its `shownAt`. The first is identity —
 * React's key, and what `dismiss` is called with, both of which would break
 * under it. The second is what stops a repeating event pinning a card on
 * screen forever: it still retires on the schedule it started.
 */
function merge(existing: FeedCard[], batch: FeedCard[]): FeedCard[] {
  const next = [...existing];

  for (const card of batch) {
    const at = next.findIndex(c => c.kind === card.kind && c.section === card.section);
    if (at === -1) {
      next.push(card);
      continue;
    }
    next[at] = {
      ...card,
      seq: next[at].seq,
      shownAt: next[at].shownAt,
      count: next[at].count + card.count,
    };
  }

  return next.slice(-MAX_CARDS);
}

/**
 * The milestone feed's behaviour, with none of its appearance.
 *
 * Split from {@link ./NarrationFeed} on ISP: this owns coalescing, suppression
 * and retention; that one owns pixels. The component takes cards and a
 * callback and never sees a `SimWorld`, which is the same posture `EventLog`
 * already holds and the reason neither can reach into the world for a rule.
 *
 * State lives here rather than on `SimWorld` because "which cards are on
 * screen" has no column behind it — the picker's precedent — and because it
 * does not need to: `seq` is monotonic, so a read position is one number in a
 * ref. Nothing joins the world, nothing is persisted, and
 * `SIM_SCHEMA_VERSION` does not move.
 */
export function useNarration(
  world: SimWorld,
  visible: Record<FeedSection, boolean>,
): Narration {
  const [cards, setCards] = useState<FeedCard[]>([]);
  const [history, setHistory] = useState<FeedCard[]>([]);
  const reduced = useReducedMotion();

  // The high-water mark. A ref, not state: it must survive StrictMode's
  // double-invoked effect without re-processing, and it must be readable and
  // writable inside the effect that consumes from it.
  const markRef = useRef(0);
  const skipRef = useRef(false);

  // Visibility is read at consume time rather than closed over, so that
  // scrolling does not re-run the consume effect. Declared before it, because
  // effects run in declaration order and both can change in one commit.
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  const resync = useCallback(() => {
    skipRef.current = true;
  }, []);

  useEffect(() => {
    const position = readPosition(world);

    // The position went backwards, so this is a different world: a reset, or a
    // scenario folded over a longer session. Adopt it silently — every line
    // below the mark belongs to a world that no longer exists. This is why
    // `world/reset` needs no `resync()` call of its own.
    if (position < markRef.current) {
      markRef.current = position;
      skipRef.current = false;
      return;
    }

    if (position === markRef.current) return;

    if (skipRef.current) {
      markRef.current = position;
      skipRef.current = false;
      return;
    }

    const fresh = milestonesSince(world, markRef.current);
    markRef.current = position;
    if (fresh.length === 0) return;

    // The collapse rule itself is in `notify.ts` — it is a claim about the
    // stream rather than about React, and a script with no browser can check
    // it there. All this adds is the arrival time the timer below counts from.
    const now = Date.now();
    const batch: FeedCard[] = coalesce(fresh).map(m => ({ ...m, shownAt: now }));

    // Suppression is about the card, never about the record. A milestone whose
    // section the visitor is already looking at does not need a card pointing
    // at it — but it still enters history, or what happened would depend on
    // where you happened to be scrolled.
    const shown = batch.filter(card => !visibleRef.current[card.section]);

    setHistory(prev => [...batch].reverse().concat(prev).slice(0, MAX_HISTORY));
    if (shown.length > 0) {
      setCards(prev => merge(prev, shown));
    }
  }, [world]);

  const dismiss = useCallback((seq: number) => {
    setCards(prev => prev.filter(card => card.seq !== seq));
  }, []);

  // Retirement, oldest first, with one timer rather than one per card. The
  // remaining time is measured from when the card arrived, so a newer arrival
  // does not silently extend an older card's stay.
  //
  // Nothing retires under reduced motion: the clock only advances by **step**
  // there, so a card that expires before the next press is a card nobody read.
  useEffect(() => {
    if (reduced || cards.length === 0) return;

    const oldest = cards[0];
    const remaining = Math.max(0, CARD_TTL - (Date.now() - oldest.shownAt));
    const timer = setTimeout(() => dismiss(oldest.seq), remaining);
    return () => clearTimeout(timer);
  }, [cards, reduced, dismiss]);

  return { cards, history, dismiss, resync };
}
