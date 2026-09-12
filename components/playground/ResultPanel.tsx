'use client';

import { useTranslations } from '@/lib/i18n';
import { decodeCursor } from '@/lib/sim/search/cursor';
import { usePlayground } from './PlaygroundContext';
import TableView, { type Column } from './TableView';
import type { SearchRow } from '@/lib/sim/search/execute';
import styles from './QueryBuilder.module.css';

/**
 * What came back — rows, a refusal, or neither.
 *
 * The three outcomes are drawn as three different things on purpose. A
 * rejection is not an empty result set with an apology attached: the engine
 * refuses *loudly* precisely so a half-built index can never masquerade as
 * "no matches", and a panel that rendered both as an empty table would undo
 * the property the whole design is built around.
 */
export default function ResultPanel() {
  const { world, dispatch } = usePlayground();
  const draft = world.queryDraft;
  const run = draft.lastRun;
  const t = useTranslations('playground');

  if (run === null) {
    return (
      <div className={`panel ${styles.panel}`}>
        <div className="panel-head">
          <span>result</span>
          <span className="tag tag-json">{t('resultPanel.nothingRunTag')}</span>
        </div>
        <p className={styles.resultEmpty}>
          {t('resultPanel.nothingRunBody1')}
          <strong>{t('resultPanel.nothingRunRun')}</strong>
          {t('resultPanel.nothingRunBody2')}
        </p>
      </div>
    );
  }

  // The fourth outcome, and it is not a refusal. A model being deleted has no
  // snapshot to reject against: ADR 0038 has the read return *nothing*,
  // indistinguishable from a model that never existed. Rendering the previous
  // result — which is what happened before this branch existed — would show
  // rows over a model whose rows are being destroyed.
  if (run.dark === true) {
    return (
      <div className={`panel ${styles.panel}`}>
        <div className="panel-head">
          <span>{t('resultPanel.darkHeader')}</span>
          <span className="tag tag-pending">
            <span className="dot" />
            {t('resultPanel.darkTag')}
          </span>
        </div>
        <p className={styles.resultEmpty}>
          {t('resultPanel.darkBody1')}
          <strong>{t('resultPanel.darkNothing')}</strong>
          {t('resultPanel.darkBody2')}
        </p>
      </div>
    );
  }

  if (run.rejection !== null) {
    const { rejection } = run;
    return (
      <div className={`panel ${styles.panel} ${styles.rejected}`}>
        <div className="panel-head">
          <span>{t('resultPanel.refusedHeader')}</span>
          <span className="tag tag-error">
            <span className="dot" />
            {rejection.errorCode}
          </span>
        </div>
        <div className={styles.rejectBody}>
          <p className={styles.exception}>
            <code>{rejection.exception}</code>
          </p>
          {/* Simulates the message a real pre-flight rejection would carry —
              untranslated in both locales, same fidelity rule as `draft.error`. */}
          <p className={styles.rejectMessage}>{rejection.message}</p>
          <p className={styles.hint}>
            {t('resultPanel.refusedHint1')}
            <code>{rejection.event}</code>
            {t('resultPanel.refusedHint2')}
            <code>reason={rejection.reason}</code>
            {t('resultPanel.refusedHint3')}
          </p>
        </div>
      </div>
    );
  }

  if (run.outcome === null) {
    return (
      <div className={`panel ${styles.panel} ${styles.rejected}`}>
        <div className="panel-head">
          <span>{t('resultPanel.decoderRejectedHeader')}</span>
          <span className="tag tag-error">
            <span className="dot" />
            {run.wireError?.errorCode}
          </span>
        </div>
        <p className={styles.rejectBody}>{t('resultPanel.decoderRejectedBody')}</p>
      </div>
    );
  }

  const { outcome } = run;
  const page = draft.cursors.length + 1;

  const columns: Column<SearchRow>[] = [
    { key: 'id', width: '70px', render: row => row.id },
    { key: 'created_at', width: '150px', render: row => row.createdAt },
    {
      key: 'fields',
      width: 'minmax(240px, 1fr)',
      render: row => <code className={styles.json}>{JSON.stringify(row.fields)}</code>,
    },
  ];

  return (
    <div className={`panel ${styles.panel}`}>
      <div className="panel-head">
        <span>{t('resultPanel.resultPageHeader', { page })}</span>
        <span className={styles.headRight}>
          <span className="tag tag-indexed">
            <span className="dot" />
            {t(outcome.rows.length === 1 ? 'resultPanel.rowsOne' : 'resultPanel.rowsMany', {
              count: outcome.rows.length,
            })}
          </span>
          <span className="tag tag-json">
            {t('resultPanel.matchedTag', { count: outcome.matchedCount })}
          </span>
        </span>
      </div>

      <div className={styles.resultBody}>
        <p className={styles.hint}>
          {t('resultPanel.probeHint1', {
            candidates: outcome.candidateCount,
            matched: outcome.matchedCount,
            materialised: outcome.rows.length,
          })}
          <strong>{t('resultPanel.probeHintBold')}</strong>
          {t('resultPanel.probeHint2')}
        </p>

        <TableView
          name="entry_data"
          note={t('resultPanel.mirrorNote')}
          columns={columns}
          rows={outcome.rows}
          rowKey={row => row.id}
          empty={t('resultPanel.emptyResult')}
        />

        <div className={styles.pager}>
          <button
            type="button"
            className="btn"
            disabled={draft.cursors.length === 0}
            onClick={() => dispatch({ type: 'query/prevPage' })}
          >
            {t('resultPanel.prevButton')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!outcome.hasMore}
            onClick={() => dispatch({ type: 'query/nextPage' })}
          >
            {t('resultPanel.nextButton')}
          </button>
          <span className={styles.pagerNote}>
            {t(outcome.hasMore ? 'resultPanel.hasMoreNote' : 'resultPanel.lastPageNote')}
          </span>
        </div>

        {outcome.nextCursor !== null && <CursorReadout token={outcome.nextCursor} />}
      </div>
    </div>
  );
}

/**
 * The next-page token, and what is inside it.
 *
 * A cursor is opaque **by contract, not by seal** — there is nothing secret in
 * it and tampering is caught by structural validation rather than
 * authentication. Showing the decoded payload is the only way to make the
 * next thing visible: the token records the *ordering* it was issued under, so
 * changing the sort mid-walk is detected instead of silently paginating
 * something else.
 */
function CursorReadout({ token }: { token: string }) {
  const decoded = decodeCursor(token);
  const t = useTranslations('playground');

  return (
    <div className={styles.cursor}>
      <span className={styles.cursorLabel}>{t('resultPanel.cursorLabel')}</span>
      <code className={styles.cursorToken}>{token}</code>
      {decoded.ok && (
        <span className={styles.cursorPayload}>
          {decoded.payload.sortKeyIdentity === null ? (
            <>
              <span className="tag tag-json">{t('resultPanel.v1Tag')}</span>
              {t('resultPanel.v1Note1')}
              <code>{decoded.payload.entryId}</code>
              {t('resultPanel.v1Note2')}
            </>
          ) : (
            <>
              <span className="tag tag-accent">{t('resultPanel.v2Tag')}</span>
              {t('resultPanel.v2Note1')}
              <code>{decoded.payload.entryId}</code>
              {t('resultPanel.v2Note2')}
              <code>
                {decoded.payload.sortKeyIdentity} {decoded.payload.direction}
              </code>
              {t('resultPanel.v2Note3')}
              <em>{t('resultPanel.v2NoteNot')}</em>
              {t('resultPanel.v2Note4')}
            </>
          )}
        </span>
      )}
    </div>
  );
}
