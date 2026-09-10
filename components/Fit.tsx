'use client';

import { useMessages } from '@/lib/i18n';
import styles from './Fit.module.css';

export default function Fit() {
  const messages = useMessages();
  const landing = (messages.landing ?? {}) as {
    fit?: {
      good?: { heading?: string; items?: string[] };
      bad?: { heading?: string; items?: string[] };
    };
  };
  const good = landing.fit?.good?.items ?? [];
  const bad = landing.fit?.bad?.items ?? [];

  return (
    <div className={styles.grid}>
      <div className={`panel ${styles.card} ${styles.good}`}>
        <div className="panel-head">
          <span>{landing.fit?.good?.heading}</span>
          <span className="tag tag-indexed">
            <span className="dot" />
            yes
          </span>
        </div>
        <ul className={styles.list}>
          {good.map(item => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      <div className={`panel ${styles.card} ${styles.bad}`}>
        <div className="panel-head">
          <span>{landing.fit?.bad?.heading}</span>
          <span className="tag tag-error">
            <span className="dot" />
            no
          </span>
        </div>
        <ul className={styles.list}>
          {bad.map(item => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
