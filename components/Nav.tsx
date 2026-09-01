'use client';

import { useEffect, useState } from 'react';
import { REPO } from '@/lib/links';
import OrbitMark from './OrbitMark';
import styles from './Nav.module.css';

const LINKS = [
  { href: '#mirror', label: 'How it works' },
  { href: '#joins', label: 'vs. EAV' },
  { href: '#lifecycle', label: 'Field lifecycle' },
  { href: '#daemons', label: 'Daemons' },
  { href: '#start', label: 'Get started' },
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
        <a href="#top" className={styles.brand}>
          <OrbitMark size={20} />
          StarDust
        </a>

        <nav className={styles.links}>
          {LINKS.map(l => (
            <a key={l.href} href={l.href}>
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
