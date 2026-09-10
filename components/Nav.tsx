'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { REPO } from '@/lib/links';
import { withLocale, useLocale, useTranslations } from '@/lib/i18n';
import BrandMark from './BrandMark';
import styles from './Nav.module.css';

/** Matches the `max-width: 900px` breakpoint in Nav.module.css. */
const NARROW = '(max-width: 900px)';

export default function Nav() {
  const locale = useLocale() as 'en' | 'id';
  const t = useTranslations('common');
  const pathname = usePathname();
  const [stuck, setStuck] = useState(false);
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLElement | null>(null);

  // Root-relative, not bare fragments. A bare `#mirror` resolves against
  // whatever route is current, so from `/playground/` it points at an anchor
  // that does not exist there. `/#mirror` is still a same-document fragment
  // jump when you are already on the home page, and a real navigation when
  // you are not — which is what both callers need. `withLocale` re-roots
  // both onto the current locale's tree (`/id/#mirror`, `/id/playground/`).
  //
  // The playground href keeps its trailing slash: `trailingSlash: true`
  // emits the route as `playground/index.html`, and the bare path only
  // reaches it through a redirect.
  const LINKS: { href: string; label: string; keep?: boolean }[] = [
    { href: withLocale(locale, '/#mirror'), label: t('nav.links.howItWorks') },
    { href: withLocale(locale, '/#joins'), label: t('nav.links.vsEav') },
    { href: withLocale(locale, '/#lifecycle'), label: t('nav.links.fieldLifecycle') },
    { href: withLocale(locale, '/#daemons'), label: t('nav.links.daemons') },
    { href: withLocale(locale, '/playground/'), label: t('nav.links.playground'), keep: true },
    { href: withLocale(locale, '/#start'), label: t('nav.links.getStarted') },
  ];

  // Strip locale prefix from pathname for linking
  const basePath = pathname.startsWith('/id') ? pathname.slice(3) || '/' : pathname;
  const otherLocaleLink = locale === 'en' ? withLocale('id', basePath) : withLocale('en', basePath);
  const otherLocaleLabel = locale === 'en' ? t('languageSwitch.indonesian') : t('languageSwitch.english');

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
        {t('nav.skipContent')}
      </a>
      <header ref={headerRef} className={`${styles.bar} ${stuck || open ? styles.stuck : ''}`}>
        <div className={`shell ${styles.inner}`}>
          <a href={withLocale(locale, '/#top')} className={styles.brand} onClick={close}>
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

          <a
            className={styles.gh}
            href={otherLocaleLink}
            title={`Switch to ${otherLocaleLabel}`}
            onClick={close}
          >
            {otherLocaleLabel}
          </a>

          <button
            type="button"
            className={styles.menuBtn}
            aria-expanded={open}
            aria-controls="nav-menu"
            aria-label={open ? t('nav.closeMenu') : t('nav.openMenu')}
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
