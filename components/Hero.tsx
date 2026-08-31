'use client';

import { useState } from 'react';
import CodeBlock from './CodeBlock';
import Starfield from './Starfield';
import { REPO } from '@/lib/links';
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

      <div className={`shell ${styles.inner}`}>
        <a className={styles.badge} href="#status">
          <span className="dot" style={{ color: 'var(--pending)' }} />
          v0.3.0 pre-release · Vertical Schema Partitioning
        </a>

        <h1 className={styles.title}>
          Schemaless dynamic fields,
          <br />
          <span className={styles.grad}>queried at native SQL index speed.</span>
        </h1>

        <p className={styles.lede}>
          Give every tenant their own fields, then filter them like first-class columns.
          No separate search cluster. No EAV join swamp. Just MySQL 8, doing an index
          scan on data you never declared at migration time.
        </p>

        <div className={styles.ctas}>
          <button type="button" className={styles.install} onClick={copyInstall}>
            <span className={styles.prompt}>$</span>
            <code>{INSTALL}</code>
            <span className={styles.copyHint}>{copied ? 'copied' : 'copy'}</span>
          </button>

          <a className="btn" href={REPO} target="_blank" rel="noreferrer">
            Read the source
          </a>
        </div>

        <div className={styles.code}>
          <CodeBlock code={SNIPPET} lang="php" title="filtering a user-defined field" />
        </div>

        <a className={styles.scroll} href="#mirror">
          <span>See what happens underneath</span>
          <span className={styles.arrow} aria-hidden="true">
            ↓
          </span>
        </a>
      </div>
    </section>
  );
}
