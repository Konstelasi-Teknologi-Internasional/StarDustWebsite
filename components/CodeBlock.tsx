'use client';

import { useMemo, useState } from 'react';
import { tokenize, type Lang } from '@/lib/highlight';
import styles from './CodeBlock.module.css';

type Props = {
  code: string;
  lang: Lang;
  title?: string;
  copyable?: boolean;
  className?: string;
};

export default function CodeBlock({ code, lang, title, copyable = false, className }: Props) {
  const tokens = useMemo(() => tokenize(code, lang), [code, lang]);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard is permission-gated and blocked outright in some embeds.
      // The code is selectable either way, so a failure needs no UI.
    }
  };

  return (
    <div className={`${styles.block} ${className ?? ''}`}>
      {(title || copyable) && (
        <div className={styles.head}>
          <span className={styles.title}>{title}</span>
          {copyable && (
            <button type="button" className={styles.copy} onClick={copy}>
              {copied ? 'copied' : 'copy'}
            </button>
          )}
        </div>
      )}
      <pre className={styles.pre}>
        <code>
          {tokens.map((t, i) => (
            <span key={i} className={styles[t.kind] ?? undefined}>
              {t.text}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
