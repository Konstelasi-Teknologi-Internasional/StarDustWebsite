'use client';

import { useEffect, useState } from 'react';
import { REPO } from '@/lib/links';
import OrbitMark from './OrbitMark';
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

export default function Nav() {
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className={`${styles.bar} ${stuck ? styles.stuck : ''}`}>
      <div className={`shell ${styles.inner}`}>
        <a href="/#top" className={styles.brand}>
          <OrbitMark size={20} />
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
      </div>
    </header>
  );
}
