'use client';

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

  if (run === null) {
    return (
      <div className={`panel ${styles.panel}`}>
        <div className="panel-head">
          <span>result</span>
          <span className="tag tag-json">nothing has run yet</span>
        </div>
        <p className={styles.resultEmpty}>
          Build a condition and press <strong>run</strong>. With no conditions at all
          the filter key is omitted, which is match-all — a perfectly good query, and
          the one every listing screen starts as.
        </p>
      </div>
    );
  }

  if (run.rejection !== null) {
    const { rejection } = run;
    return (
      <div className={`panel ${styles.panel} ${styles.rejected}`}>
        <div className="panel-head">
          <span>result · refused at pre-flight</span>
          <span className="tag tag-error">
            <span className="dot" />
            {rejection.errorCode}
          </span>
        </div>
        <div className={styles.rejectBody}>
          <p className={styles.exception}>
            <code>{rejection.exception}</code>
          </p>
          <p className={styles.rejectMessage}>{rejection.message}</p>
          <p className={styles.hint}>
            Nothing was executed. The refusal came from the pre-flight pipeline before
            any SQL was built, which is why there is no plan below — and it is logged
            as <code>{rejection.event}</code> with{' '}
            <code>reason={rejection.reason}</code> so an operator can count it.
          </p>
        </div>
      </div>
    );
  }

  if (run.outcome === null) {
    return (
      <div className={`panel ${styles.panel} ${styles.rejected}`}>
        <div className="panel-head">
          <span>result · rejected by the decoder</span>
          <span className="tag tag-error">
            <span className="dot" />
            {run.wireError?.errorCode}
          </span>
        </div>
        <p className={styles.rejectBody}>
          The envelope never became a filter, so nothing reached the registry. The
          pointer above the editor names the node.
        </p>
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
        <span>result · page {page}</span>
        <span className={styles.headRight}>
          <span className="tag tag-indexed">
            <span className="dot" />
            {outcome.rows.length} row{outcome.rows.length === 1 ? '' : 's'}
          </span>
          <span className="tag tag-json">{outcome.matchedCount} matched</span>
        </span>
      </div>

      <div className={styles.resultBody}>
        <p className={styles.hint}>
          The probe considered {outcome.candidateCount} rows of this model,{' '}
          {outcome.matchedCount} matched, and {outcome.rows.length} were materialised.
          {' '}
          <strong>The engine never reports that middle number</strong> — there is no
          count query and no total; it is on screen here because the simulation can see
          the whole table and a real read deliberately cannot.
        </p>

        <TableView
          name="entry_data"
          note="the payload, verbatim"
          columns={columns}
          rows={outcome.rows}
          rowKey={row => row.id}
          empty={
            <>
              No rows matched. That is an answer, not a failure — and it is a different
              thing from the refusals above, which is why this panel looks different
              when one happens.
            </>
          }
        />

        <div className={styles.pager}>
          <button
            type="button"
            className="btn"
            disabled={draft.cursors.length === 0}
            onClick={() => dispatch({ type: 'query/prevPage' })}
          >
            ← previous
          </button>
          <button
            type="button"
            className="btn"
            disabled={!outcome.hasMore}
            onClick={() => dispatch({ type: 'query/nextPage' })}
          >
            next →
          </button>
          <span className={styles.pagerNote}>
            {outcome.hasMore
              ? 'the probe asked for pageSize + 1 rows and got them, so there is another page'
              : 'the probe came back short of pageSize + 1, so this is the last page'}
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

  return (
    <div className={styles.cursor}>
      <span className={styles.cursorLabel}>nextCursor</span>
      <code className={styles.cursorToken}>{token}</code>
      {decoded.ok && (
        <span className={styles.cursorPayload}>
          {decoded.payload.sortKeyIdentity === null ? (
            <>
              <span className="tag tag-json">v1</span> anchor id{' '}
              <code>{decoded.payload.entryId}</code> — the format that predates sorting,
              still emitted for an unsorted read so old tokens keep working
            </>
          ) : (
            <>
              <span className="tag tag-accent">v2</span> anchor id{' '}
              <code>{decoded.payload.entryId}</code>, ordering{' '}
              <code>
                {decoded.payload.sortKeyIdentity} {decoded.payload.direction}
              </code>{' '}
              — the value itself is <em>not</em> in the token; it is resolved from the
              anchor row at query time, which keeps the token constant-size
            </>
          )}
        </span>
      )}
    </div>
  );
}
