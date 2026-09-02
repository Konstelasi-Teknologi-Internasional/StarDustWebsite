'use client';

/**
 * Animates a ghost element from one live DOM rect to another.
 *
 * The demos move values between tables that are laid out independently and
 * reflow at every breakpoint, so the path can't be authored as a fixed SVG
 * curve — it has to be measured at fire time. The ghost is position:fixed,
 * so the measured viewport rects are already in its coordinate space.
 */
export type FlyOptions = {
  label: string;
  /**
   * Maps to a `.flyGhost--{tone}` class in `globals.css`; adding one means
   * editing both files.
   *
   * `json` is the neutral one, and it exists because the ramp is load-bearing:
   * rose means *rejected or tombstoned*, and a value that lands in the JSON
   * payload and is never mirrored is neither. It is at its steady state, and
   * colouring it as a failure would teach the opposite of what ADR 0034 says.
   */
  tone?: 'accent' | 'indexed' | 'pending' | 'danger' | 'json';
  duration?: number;
  delay?: number;
  /** Stop this fraction along the path and dissolve, instead of landing. */
  stopAt?: number;
};

export function fly(
  layer: HTMLElement,
  from: HTMLElement,
  to: HTMLElement,
  opts: FlyOptions,
): Promise<void> {
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const duration = opts.duration ?? 620;
  const stopAt = opts.stopAt ?? 1;

  const ghost = document.createElement('div');
  ghost.textContent = opts.label;
  ghost.className = `flyGhost flyGhost--${opts.tone ?? 'accent'}`;
  ghost.style.position = 'fixed';
  ghost.style.left = '0';
  ghost.style.top = '0';
  ghost.style.willChange = 'transform, opacity';
  layer.appendChild(ghost);

  // Measure the ghost only after it is in the document, so its own size is
  // real and both endpoints can be centred on their targets.
  const g = ghost.getBoundingClientRect();
  const start = {
    x: a.left + a.width / 2 - g.width / 2,
    y: a.top + a.height / 2 - g.height / 2,
  };
  const end = {
    x: b.left + b.width / 2 - g.width / 2,
    y: b.top + b.height / 2 - g.height / 2,
  };
  const mid = {
    x: start.x + (end.x - start.x) * stopAt,
    y: start.y + (end.y - start.y) * stopAt,
  };

  // A slight arc reads as travel rather than as a teleport.
  const lift = Math.min(46, Math.abs(end.x - start.x) * 0.16) * -1;

  const anim = ghost.animate(
    [
      { transform: `translate(${start.x}px, ${start.y}px) scale(0.86)`, opacity: 0 },
      { transform: `translate(${(start.x + mid.x) / 2}px, ${(start.y + mid.y) / 2 + lift}px) scale(1)`, opacity: 1, offset: 0.45 },
      {
        transform: `translate(${mid.x}px, ${mid.y}px) scale(${stopAt < 1 ? 0.9 : 0.94})`,
        opacity: stopAt < 1 ? 0 : 1,
      },
    ],
    { duration, delay: opts.delay ?? 0, easing: 'cubic-bezier(0.4, 0.02, 0.2, 1)', fill: 'forwards' },
  );

  return anim.finished
    .catch(() => undefined)
    .then(() => {
      ghost.remove();
    });
}

/** Removes every ghost still in flight — used when a demo is reset mid-run. */
export function clearFlights(layer: HTMLElement) {
  layer.replaceChildren();
}
