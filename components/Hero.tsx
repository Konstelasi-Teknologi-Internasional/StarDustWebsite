'use client';

import { useState } from 'react';
import CodeBlock from './CodeBlock';
import BrandMark from './BrandMark';
import Starfield from './Starfield';
import { REPO } from '@/lib/links';
import { useLocale, useTranslations, withLocale } from '@/lib/i18n';
import styles from './Hero.module.css';

const SNIPPET = `// "industry" and "employees" are user-defined fields, not table
// columns — yet this compiles to an indexed range scan.
$page = $engine->read(new EntryQuery(
    tenantId: 1,
    modelId:  $companyModelId,
    filter:   new AndNode([
        LeafNode::local('industry',  'eq', 'software'),
        LeafNode::local('employees', 'gt', 100),
    ]),
    selectFields: ['name', 'employees'],
));`;

const INSTALL = 'composer require damarbob/stardust';

export default function Hero() {
  const locale = useLocale();
  const t = useTranslations('landing');
  const [copied, setCopied] = useState(false);

  const copyInstall = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* selectable regardless */
    }
  };

  return (
    <section className={styles.hero} id="top">
      <Starfield />
      {/* PLACEMENT 2 — ambient watermark. Remove this line alone to cut it. */}
      <BrandMark size={640} className={styles.watermark} />

      <div className={`shell ${styles.inner}`}>
        {/* PLACEMENT 1 — hero centerpiece. Remove this line alone to cut it. */}
        <BrandMark size={104} className={styles.mark} />

        <a className={styles.badge} href="#status">
          <span className="dot" style={{ color: 'var(--pending)' }} />
          {t('hero.badge')}
        </a>

        <h1 className={styles.title}>
          {t('hero.titleLine1')}
          <br />
          <span className={styles.grad}>{t('hero.titleLine2')}</span>
        </h1>

        <p className={styles.lede}>{t('hero.lede')}</p>

        <div className={styles.ctas}>
          <button type="button" className={styles.install} onClick={copyInstall}>
            <span className={styles.prompt}>$</span>
            <code>{INSTALL}</code>
            <span className={styles.copyHint}>{copied ? t('hero.copied') : t('hero.copy')}</span>
          </button>

          <a className="btn" href={REPO} target="_blank" rel="noreferrer">
            {t('hero.readSource')}
          </a>
        </div>

        <div className={styles.code}>
          <CodeBlock code={SNIPPET} lang="php" title={t('hero.codeTitle')} />
        </div>

        <a className={styles.scroll} href={withLocale(locale, '/#mirror')}>
          <span>{t('hero.scroll')}</span>
          <span className={styles.arrow} aria-hidden="true">
            ↓
          </span>
        </a>
      </div>
    </section>
  );
}
