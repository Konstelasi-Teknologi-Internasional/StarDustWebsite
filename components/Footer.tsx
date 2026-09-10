'use client';

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
import { useTranslations } from '@/lib/i18n';
import BrandMark from './BrandMark';
import styles from './Footer.module.css';

export default function Footer() {
  const t = useTranslations('common');

  const COLUMNS: { heading: string; links: { href: string; label: string }[] }[] = [
    {
      heading: t('footer.columns.project'),
      links: [
        { href: REPO, label: t('footer.links.source') },
        { href: DOCS, label: t('footer.links.documentation') },
        { href: EXAMPLES, label: t('footer.links.examples') },
        { href: CHANGELOG, label: t('footer.links.changelog') },
      ],
    },
    {
      heading: t('footer.columns.getIt'),
      links: [
        { href: PACKAGIST, label: t('footer.links.packagist') },
        { href: CONTRIBUTING, label: t('footer.links.contributing') },
        { href: ISSUES, label: t('footer.links.issues') },
        { href: SITE_REPO, label: t('footer.links.siteSource') },
      ],
    },
  ];

  return (
    <footer className={styles.footer}>
      {/* PLACEMENT 3 — quiet closing signature. Remove this block alone to cut it. */}
      <div className={`shell ${styles.signature}`}>
        <BrandMark size={96} className={styles.signatureMark} />
        <p className={styles.tagline}>{t('footer.tagline')}</p>
      </div>

      <div className={`shell ${styles.inner}`}>
        <div className={styles.brandCol}>
          <span className={styles.brand}>
            <BrandMark size={18} />
            StarDust
          </span>
          <p className={styles.tag}>{t('footer.description')}</p>
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
        <span>{t('footer.copyright', { year: new Date().getFullYear() })}</span>
        <span>MIT</span>
      </div>
    </footer>
  );
}
