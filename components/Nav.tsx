'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { REPO } from '@/lib/links';
import BrandMark from './BrandMark';
import styles from './Nav.module.css';

// Root-relative, not bare fragments. A bare `#mirror` resolves against
// whatever route is current, so from `/playground/` it points at an anchor
// that does not exist there. `/#mirror` is still a same-document fragment
// jump when you are already on the home page, and a real navigation when you
// are not — which is what both callers need.
//
// The playground href keeps its trailing slash: `trailingSlash: true` emits
// the route as `playground/index.html`, and the bare path only reaches it
// through a redirect.
const LINKS: { href: string; label: string; keep?: boolean }[] = [
  { href: '/#mirror', label: 'How it works' },
  { href: '/#joins', label: 'vs. EAV' },
  { href: '/#lifecycle', label: 'Field lifecycle' },
  { href: '/#daemons', label: 'Daemons' },
  { href: '/playground/', label: 'Playground', keep: true },
  { href: '/#start', label: 'Get started' },
];

/** Matches the `max-width: 900px` breakpoint in Nav.module.css. */
const NARROW = '(max-width: 900px)';

export default function Nav() {
  const [stuck, setStuck] = useState(false);
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Widening past the breakpoint puts the links back in the bar, so a menu
  // left open would sit under a nav that already shows everything in it.
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const onChange = () => { if (!mq.matches) close(); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [close]);

  // Every anchor here is a same-document fragment jump when you are already
  // on the home page — no navigation, so nothing else would dismiss the
  // menu. Escape and an outside click cover the rest.
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onPointer = (e: PointerEvent) => {
      const header = headerRef.current;
      if (header && e.target instanceof Node && !header.contains(e.target)) close();
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open, close]);

  return (
    <>
      {/* First focusable element on every page. A bare fragment, not
          root-relative like the links below: it always targets `#main` on
          *this* document, and both routes render one. */}
      <a href="#main" className="sr-only skip-link">
        Skip to content
      </a>
      <header ref={headerRef} className={`${styles.bar} ${stuck || open ? styles.stuck : ''}`}>
        <div className={`shell ${styles.inner}`}>
          <a href="/#top" className={styles.brand} onClick={close}>
            <BrandMark size={20} />
            StarDust
          </a>

          <nav className={styles.links}>
            {LINKS.map(l => (
              <a key={l.href} href={l.href} className={l.keep ? styles.keep : undefined}>
                {l.label}
              </a>
            ))}
          </nav>

          <a className={styles.gh} href={REPO} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>

          <button
            type="button"
            className={styles.menuBtn}
            aria-expanded={open}
            aria-controls="nav-menu"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen(v => !v)}
          >
            <span className={`${styles.burger} ${open ? styles.burgerOpen : ''}`} aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </button>
        </div>

        {/* `hidden` rather than an unmounted subtree: the panel is small, and
            keeping it in the DOM means the button's aria-controls always
            resolves to a real element. */}
        <div id="nav-menu" className={styles.menu} hidden={!open}>
          <div className="shell">
            {LINKS.map(l => (
              <a
                key={l.href}
                href={l.href}
                className={l.keep ? styles.keep : undefined}
                onClick={close}
              >
                {l.label}
              </a>
            ))}
            <a href={REPO} target="_blank" rel="noreferrer" onClick={close}>
              GitHub ↗
            </a>
          </div>
        </div>
      </header>
    </>
  );
}
