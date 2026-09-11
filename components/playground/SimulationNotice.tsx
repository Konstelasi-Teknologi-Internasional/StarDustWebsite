'use client';

import { REPO } from '@/lib/links';
import { useTranslations } from '@/lib/i18n';
import styles from './SimulationNotice.module.css';

/**
 * The label that keeps this page honest.
 *
 * There is no Node runtime, no PHP and no MySQL behind a static site, so the
 * playground cannot run the real engine — it is a hand-written simulation of
 * it. Saying so plainly costs nothing and is the difference between a
 * teaching tool and a page that quietly teaches something untrue.
 */
export default function SimulationNotice() {
  const t = useTranslations('playground');

  return (
    <aside className={`panel ${styles.notice}`}>
      <span className="tag tag-pending">
        <span className="dot" />
        {t('simulationNotice.tag')}
      </span>
      <p>
        {t('simulationNotice.before')}
        <a href={REPO} target="_blank" rel="noreferrer">
          {t('simulationNotice.linkText')}
        </a>
        {t('simulationNotice.after')}
      </p>
    </aside>
  );
}
