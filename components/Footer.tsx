import {
  CHANGELOG,
  CONTRIBUTING,
  DOCS,
  EXAMPLES,
  ISSUES,
  PACKAGIST,
  REPO,
  SITE_REPO,
} from '@/lib/links';
import OrbitMark from './OrbitMark';
import styles from './Footer.module.css';

const COLUMNS: { heading: string; links: { href: string; label: string }[] }[] = [
  {
    heading: 'Project',
    links: [
      { href: REPO, label: 'Source' },
      { href: DOCS, label: 'Documentation' },
      { href: EXAMPLES, label: 'Examples' },
      { href: CHANGELOG, label: 'Changelog' },
    ],
  },
  {
    heading: 'Get it',
    links: [
      { href: PACKAGIST, label: 'Packagist' },
      { href: CONTRIBUTING, label: 'Contributing' },
      { href: ISSUES, label: 'Issues' },
      { href: SITE_REPO, label: 'Source of this site' },
    ],
  },
];

export default function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={`shell ${styles.inner}`}>
        <div className={styles.brandCol}>
          <span className={styles.brand}>
            <OrbitMark size={18} />
            StarDust
          </span>
          <p className={styles.tag}>
            MySQL-native Vertical Schema Partitioning for dynamic data models.
            Framework-neutral, MIT licensed.
          </p>
        </div>

        <nav className={styles.links}>
          {COLUMNS.map(col => (
            <div key={col.heading}>
              <h3>{col.heading}</h3>
              {col.links.map(l => (
                <a key={l.href} href={l.href} target="_blank" rel="noreferrer">
                  {l.label}
                </a>
              ))}
            </div>
          ))}
        </nav>
      </div>

      <div className={`shell ${styles.legal}`}>
        <span>© {new Date().getFullYear()} Konstelasi Teknologi Internasional</span>
        <span>MIT</span>
      </div>
    </footer>
  );
}
