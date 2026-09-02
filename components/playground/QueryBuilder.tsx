'use client';

import { useState } from 'react';
import type { SortDirection, SortTarget } from '@/lib/sim/search/sort';
import { fieldIndexState, fieldsOf } from '@/lib/sim/world';
import EventLog from './EventLog';
import FilterTree from './FilterTree';
import { usePlayground } from './PlaygroundContext';
import QueryPlan from './QueryPlan';
import ResultPanel from './ResultPanel';
import WirePane from './WirePane';
import styles from './QueryBuilder.module.css';

/**
 * Section E — query it.
 *
 * The section every earlier one was for. The schema came from A, the rows from
 * C, and the index from D — and this is where a filter either reads that index
 * or is refused for a reason the visitor watched happen thirty seconds ago.
 *
 * Three outcomes, all real and all reachable without trying to break anything:
 *
 *   - the two-query bounded plan, with the actual predicate over the actual
 *     slot column;
 *   - a **pre-flight rejection** naming the field and why — not filterable,
 *     still backfilling, unknown;
 *   - a **wire-format validation error** carrying a JSON Pointer to the node
 *     that failed.
 *
 * The one to watch for is the second. A filter against a half-built index is
 * refused loudly rather than answered from what has been indexed so far, which
 * is the difference between a system that is honestly incomplete and one that
 * quietly returns the wrong answer.
 */
export default function QueryBuilder() {
  const { world, dispatch } = usePlayground();
  const draft = world.queryDraft;
  const models = world.models.filter(m => m.deletedAt === null);
  const fields = draft.modelId === null ? [] : fieldsOf(world, draft.modelId);
  const [addField, setAddField] = useState('');

  const firstField = fields[0]?.name ?? '';
  const fieldToAdd = fields.some(f => f.name === addField) ? addField : firstField;

  return (
    <section className={styles.section} id="query" aria-labelledby="query-title">
      <p className="eyebrow">section e</p>
      <h2 id="query-title" className={styles.title}>
        Query it
      </h2>
      <p className="section-lede">
        Build a filter against the schema you defined, over the rows you wrote, using
        the index the daemons built. Then break it on purpose: filter a field nobody
        promoted, or hand the decoder JSON it will not take, and read what comes back
        instead of rows.
      </p>

      <div className={styles.beats}>
        <div className={styles.beat}>
          <h3 className={styles.beatTitle}>Two queries, however many conditions</h3>
          <p>
            One bounded probe over the joined pages returns <code>pageSize + 1</code>{' '}
            ids; one fetch materialises them. Stack five conditions across three pages
            and it is still two queries and still one row per entry per page — no
            fan-out, because the values live in columns rather than in rows.
          </p>
        </div>
        <div className={styles.beat}>
          <h3 className={styles.beatTitle}>A filter reads the slot, not the JSON</h3>
          <p>
            <code>entry_data.fields</code> is the system of record and it is not what a
            filter touches. A row the backfill has not reached has no row on the page
            at all, so it matches nothing — <code>is_null</code> included, because that
            still needs a row to exist. Stop the Reconciler mid-drain and you can watch
            the two halves of the model answer differently.
          </p>
        </div>
      </div>

      {models.length === 0 ? (
        <div className={`panel ${styles.empty}`}>
          <p>
            Define a model in section A first, and write a few rows in section C. This
            section filters what those two produced; with an empty registry there is
            nothing to build a condition against.
          </p>
        </div>
      ) : (
        <>
          <div className={`panel ${styles.controls}`}>
            <div className="panel-head">
              <span>request</span>
              <span className={styles.headRight}>
                <label className={styles.label} htmlFor="query-model">
                  model
                </label>
                <select
                  id="query-model"
                  className={styles.select}
                  value={draft.modelId ?? ''}
                  onChange={e =>
                    dispatch({ type: 'query/selectModel', modelId: Number(e.target.value) })
                  }
                >
                  <option value="" disabled>
                    pick one
                  </option>
                  {models.map(m => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </span>
            </div>

            <div className={styles.controlsBody}>
              {draft.modelId === null ? (
                <p className={styles.hint}>Pick a model to filter.</p>
              ) : (
                <>
                  <div className={styles.tree}>
                    {draft.tree === null ? (
                      <p className={styles.matchAll}>
                        No conditions. The envelope omits its <code>filter</code> key
                        entirely, which is the match-all signal — every non-deleted row of
                        this model, cursor-paginated.
                      </p>
                    ) : (
                      <FilterTree node={draft.tree} path={[]} />
                    )}
                  </div>

                  <div className={styles.addRow}>
                    <select
                      className={styles.select}
                      aria-label="field to add a condition on"
                      value={fieldToAdd}
                      onChange={e => setAddField(e.target.value)}
                    >
                      {fields.map(f => (
                        <option key={f.id} value={f.name}>
                          {f.name} · {f.declaredType}
                          {fieldIndexState(world, f.id) === 'live' ? '' : ' (not indexed)'}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn"
                      disabled={fields.length === 0}
                      onClick={() =>
                        dispatch({ type: 'query/addCondition', fieldName: fieldToAdd })
                      }
                    >
                      + condition
                    </button>
                    <span className={styles.hint}>
                      Conditions join with <code>and</code> by default. Use{' '}
                      <code>or</code> or <code>not</code> on a row to group it — that is
                      what moves the compiler onto the EXISTS strategy.
                    </span>
                  </div>

                  <div className={styles.sortRow}>
                    <label className={styles.label} htmlFor="query-sort">
                      sort
                    </label>
                    <select
                      id="query-sort"
                      className={styles.select}
                      value={
                        draft.sortTarget === 'field'
                          ? `field:${draft.sortFieldName ?? ''}`
                          : draft.sortTarget
                      }
                      onChange={e => {
                        const value = e.target.value;
                        const target: SortTarget = value.startsWith('field:') ? 'field' : (value as SortTarget);
                        dispatch({
                          type: 'query/setSort',
                          target,
                          fieldName: target === 'field' ? value.slice('field:'.length) : null,
                          direction: draft.sortDirection,
                        });
                      }}
                    >
                      <option value="id">entry_data.id</option>
                      <option value="created_at">entry_data.created_at</option>
                      {fields.map(f => (
                        <option key={f.id} value={`field:${f.name}`}>
                          {f.name} (slot column)
                        </option>
                      ))}
                    </select>

                    <select
                      className={styles.select}
                      aria-label="sort direction"
                      value={draft.sortDirection}
                      onChange={e =>
                        dispatch({
                          type: 'query/setSort',
                          target: draft.sortTarget,
                          fieldName: draft.sortFieldName,
                          direction: e.target.value as SortDirection,
                        })
                      }
                    >
                      <option value="asc">ascending</option>
                      <option value="desc">descending</option>
                    </select>

                    <label className={styles.label} htmlFor="query-page-size">
                      pageSize
                    </label>
                    <input
                      id="query-page-size"
                      className={styles.number}
                      type="number"
                      min={1}
                      max={100}
                      value={draft.pageSize}
                      onChange={e =>
                        dispatch({
                          type: 'query/setPageSize',
                          size: Math.max(1, Math.min(100, Number(e.target.value) || 1)),
                        })
                      }
                    />

                    <span className={styles.grow} />

                    <button
                      type="button"
                      className="btn"
                      onClick={() => dispatch({ type: 'query/reset' })}
                    >
                      clear
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => dispatch({ type: 'query/run' })}
                    >
                      run
                    </button>
                  </div>

                  <p className={styles.sortNote}>
                    Sorting is <strong>not part of the wire format</strong> — it is a
                    parameter alongside the filter, which is why it is up here and not in
                    the JSON below. The two intrinsic targets stay index-ordered; a sort on
                    a field is an honest filesort over the whole filtered set.
                  </p>
                </>
              )}
            </div>
          </div>

          <div className={styles.grid}>
            <div className={styles.column}>
              <WirePane />
              <QueryPlan />
            </div>
            <div className={styles.column}>
              <ResultPanel />
              <EventLog
                events={world.events}
                sources={['api']}
                title="what the API logged"
                note="source=api"
                height="200px"
                empty={
                  <>
                    Nothing yet. A search logs one <code>search_request</code> line; a
                    refusal logs <code>pre_flight_rejected</code> with the reason instead,
                    and never both.
                  </>
                }
              />
            </div>
          </div>
        </>
      )}
    </section>
  );
}
