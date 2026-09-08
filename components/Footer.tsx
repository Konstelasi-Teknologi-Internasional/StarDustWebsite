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
import BrandMark from './BrandMark';
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
      {/* PLACEMENT 3 — quiet closing signature. Remove this block alone to cut it. */}
      <div className={`shell ${styles.signature}`}>
        <BrandMark size={96} className={styles.signatureMark} />
        <p className={styles.tagline}>
          Schemaless dynamic fields, queried at native SQL index speed.
        </p>
      </div>

      <div className={`shell ${styles.inner}`}>
        <div className={styles.brandCol}>
          <span className={styles.brand}>
            <BrandMark size={18} />
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
