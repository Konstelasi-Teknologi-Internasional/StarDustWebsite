'use client';

import { useState } from 'react';
import CodeBlock from '@/components/CodeBlock';
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

  const text = draft.wireText ?? encodeEnvelope(draft.tree);
  // A run can fail on text that has since been edited back to valid, so the
  // live decode error wins and the last run's is the fallback.
  const error = draft.wireError ?? draft.lastRun?.wireError ?? null;

  return (
    <div className={`panel ${styles.panel}`}>
      <div className="panel-head">
        <span>queryfilter · {view === 'json' ? 'wire format' : 'decoded AST'}</span>
        <span className={styles.headRight}>
          <button
            type="button"
            className={`${styles.iconBtn} ${view === 'json' ? styles.iconBtnOn : ''}`}
            aria-pressed={view === 'json'}
            onClick={() => setView('json')}
          >
            JSON
          </button>
          <button
            type="button"
            className={`${styles.iconBtn} ${view === 'ast' ? styles.iconBtnOn : ''}`}
            aria-pressed={view === 'ast'}
            onClick={() => setView('ast')}
          >
            PHP AST
          </button>
          {draft.wireText !== null && view === 'json' && (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => dispatch({ type: 'query/syncWire' })}
              title="Discard the hand-edited text and re-derive it from the builder"
            >
              re-derive
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
            title="what JsonFilterDecoder::decode() returns"
            copyable
          />
          <p className={styles.hint}>
            The tree the decoder produces, before pre-flight touches it. Each{' '}
            <code>FieldRef</code> here carries only the two names the wire format
            sent; resolution adds the <code>modelId</code>, <code>fieldId</code> and
            descriptor, which is the step that can fail with{' '}
            <code>field_unknown</code>.
          </p>
        </div>
      ) : (
      <div className={styles.wireBody}>
        <textarea
          className={styles.wire}
          value={text}
          spellCheck={false}
          aria-label="QueryFilter wire format"
          rows={Math.min(24, Math.max(6, text.split('\n').length + 1))}
          onChange={e => dispatch({ type: 'query/setWireText', text: e.target.value })}
        />

        {error === null ? (
          <p className={styles.wireOk}>
            Decodes. The engine&rsquo;s <code>JsonFilterDecoder</code> accepts this
            envelope, and running the query decodes this exact text — not the builder
            above it.
          </p>
        ) : (
          <div className={styles.wireError} role="status">
            <span className="tag tag-error">
              <span className="dot" />
              {error.errorCode}
            </span>
            <code className={styles.pointer}>
              {error.jsonPointer === '' ? '(whole envelope)' : error.jsonPointer}
            </code>
            <p>{error.message}</p>
          </div>
        )}

        <p className={styles.hint}>
          The <code>filter</code> key is <strong>omitted</strong> for match-all, never
          set to <code>null</code> — sending <code>null</code> is the one shape the
          decoder singles out, on the grounds that a caller who meant everything had a
          way to say so.
        </p>
      </div>
      )}
    </div>
  );
}
