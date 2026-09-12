'use client';

import { useState } from 'react';
import CodeBlock from '@/components/CodeBlock';
import { useTranslations } from '@/lib/i18n';
import { encodeEnvelope } from '@/lib/sim/filter/encode';
import { filterAstSnippetFull } from '@/lib/sim/php';
import { usePlayground } from './PlaygroundContext';
import styles from './QueryBuilder.module.css';

/**
 * The QueryFilter wire format, editable.
 *
 * This is the same tree the builder above edits, in the JSON a gateway would
 * put on the wire — and it is a textarea rather than a read-only pane for a
 * specific reason: a builder can only ever emit valid trees, so without
 * somewhere to type, nine of the thirteen error codes would be unreachable and
 * the decoder would be a component nobody could see working.
 *
 * The round trip runs in both directions. Editing the builder re-derives this
 * text; typing here decodes and replaces the builder's tree, so a hand-written
 * `not` group appears above as a `not` group. A rejected edit keeps the
 * previous tree — the builder does not empty itself while someone is halfway
 * through a keystroke — and says why, with the RFC 6901 pointer to the node
 * that failed.
 */
export default function WirePane() {
  const { world, dispatch } = usePlayground();
  const draft = world.queryDraft;
  const [view, setView] = useState<'json' | 'ast'>('json');
  const t = useTranslations('playground');

  const text = draft.wireText ?? encodeEnvelope(draft.tree);
  // A run can fail on text that has since been edited back to valid, so the
  // live decode error wins and the last run's is the fallback.
  const error = draft.wireError ?? draft.lastRun?.wireError ?? null;

  return (
    <div className={`panel ${styles.panel}`}>
      <div className="panel-head">
        <span>
          {t('wirePane.viewLabel', {
            view: view === 'json' ? t('wirePane.wireFormatView') : t('wirePane.astView'),
          })}
        </span>
        <span className={styles.headRight}>
          <button
            type="button"
            className={`${styles.iconBtn} ${view === 'json' ? styles.iconBtnOn : ''}`}
            aria-pressed={view === 'json'}
            onClick={() => setView('json')}
          >
            {t('wirePane.jsonButton')}
          </button>
          <button
            type="button"
            className={`${styles.iconBtn} ${view === 'ast' ? styles.iconBtnOn : ''}`}
            aria-pressed={view === 'ast'}
            onClick={() => setView('ast')}
          >
            {t('wirePane.astButton')}
          </button>
          {draft.wireText !== null && view === 'json' && (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => dispatch({ type: 'query/syncWire' })}
              title={t('wirePane.rederiveTitle')}
            >
              {t('wirePane.rederiveButton')}
            </button>
          )}
        </span>
      </div>

      {/* Two views of one filter. The JSON is what a gateway receives; the AST
          is what the decoder hands the rest of the engine, and what pre-flight
          and the compiler actually walk. Only the JSON is editable — the AST is
          an output, and a text box you cannot type into is clearer about that
          than a disabled one would be. */}
      {view === 'ast' ? (
        <div className={styles.wireBody}>
          <CodeBlock
            code={filterAstSnippetFull(draft.tree)}
            lang="php"
            title={t('wirePane.astTitle')}
            copyable
          />
          <p className={styles.hint}>
            {t('wirePane.astHint1')}
            <code>FieldRef</code>
            {t('wirePane.astHint2')}
            <code>modelId</code>
            {t('wirePane.astHint3')}
            <code>fieldId</code>
            {t('wirePane.astHint4')}
            <code>field_unknown</code>
            {t('wirePane.astHint5')}
          </p>
        </div>
      ) : (
      <div className={styles.wireBody}>
        <textarea
          className={styles.wire}
          value={text}
          spellCheck={false}
          aria-label={t('wirePane.wireAriaLabel')}
          rows={Math.min(24, Math.max(6, text.split('\n').length + 1))}
          onChange={e => dispatch({ type: 'query/setWireText', text: e.target.value })}
        />

        {error === null ? (
          <p className={styles.wireOk}>
            {t('wirePane.decodesNote1')}
            <code>JsonFilterDecoder</code>
            {t('wirePane.decodesNote2')}
          </p>
        ) : (
          <div className={styles.wireError} role="status">
            <span className="tag tag-error">
              <span className="dot" />
              {error.errorCode}
            </span>
            <code className={styles.pointer}>
              {error.jsonPointer === '' ? t('wirePane.wholeEnvelope') : error.jsonPointer}
            </code>
            {/* Simulates the message a real decoder rejection would carry —
                untranslated in both locales, same fidelity rule as `draft.error`. */}
            <p>{error.message}</p>
          </div>
        )}

        <p className={styles.hint}>
          {t('wirePane.filterKeyHint1')}
          <code>filter</code>
          {t('wirePane.filterKeyHint2')}
          <strong>{t('wirePane.filterKeyHintOmitted')}</strong>
          {t('wirePane.filterKeyHint3')}
          <code>null</code>
          {t('wirePane.filterKeyHint4')}
          <code>null</code>
          {t('wirePane.filterKeyHint5')}
        </p>
      </div>
      )}
    </div>
  );
}
