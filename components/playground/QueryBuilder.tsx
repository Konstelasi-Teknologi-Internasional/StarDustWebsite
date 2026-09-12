'use client';

import { useState } from 'react';
import { useTranslations } from '@/lib/i18n';
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
  const t = useTranslations('playground');

  const firstField = fields[0]?.name ?? '';
  const fieldToAdd = fields.some(f => f.name === addField) ? addField : firstField;

  return (
    <section className={styles.section} id="query" aria-labelledby="query-title" tabIndex={-1}>
      <p className="eyebrow">{t('queryBuilder.eyebrow')}</p>
      <h2 id="query-title" className={styles.title}>
        {t('queryBuilder.heading')}
      </h2>
      <p className="section-lede">{t('queryBuilder.lede')}</p>

      <div className={styles.beats}>
        <div className={styles.beat}>
          <h3 className={styles.beatTitle}>{t('queryBuilder.beat1Title')}</h3>
          <p>
            {t('queryBuilder.beat1Body1')}
            <code>pageSize + 1</code>
            {t('queryBuilder.beat1Body2')}
          </p>
        </div>
        <div className={styles.beat}>
          <h3 className={styles.beatTitle}>{t('queryBuilder.beat2Title')}</h3>
          <p>
            <code>entry_data.fields</code>
            {t('queryBuilder.beat2Body1')}
            <code>is_null</code>
            {t('queryBuilder.beat2Body2')}
          </p>
        </div>
      </div>

      {models.length === 0 ? (
        <div className={`panel ${styles.empty}`}>
          <p>{t('queryBuilder.emptyBody')}</p>
        </div>
      ) : (
        <>
          <div className={`panel ${styles.controls}`}>
            <div className="panel-head">
              <span>{t('queryBuilder.requestLabel')}</span>
              <span className={styles.headRight}>
                <label className={styles.label} htmlFor="query-model">
                  {t('queryBuilder.modelLabel')}
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
                    {t('queryBuilder.pickOne')}
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
                <p className={styles.hint}>{t('queryBuilder.hintPickModel')}</p>
              ) : (
                <>
                  <div className={styles.tree}>
                    {draft.tree === null ? (
                      <p className={styles.matchAll}>
                        {t('queryBuilder.matchAllBefore')}
                        <code>filter</code>
                        {t('queryBuilder.matchAllAfter')}
                      </p>
                    ) : (
                      <FilterTree node={draft.tree} path={[]} />
                    )}
                  </div>

                  <div className={styles.addRow}>
                    <select
                      className={styles.select}
                      aria-label={t('queryBuilder.addFieldAriaLabel')}
                      value={fieldToAdd}
                      onChange={e => setAddField(e.target.value)}
                    >
                      {fields.map(f => (
                        <option key={f.id} value={f.name}>
                          {f.name} · {f.declaredType}
                          {fieldIndexState(world, f.id) === 'live'
                            ? ''
                            : t('queryBuilder.notIndexedSuffix')}
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
                      {t('queryBuilder.addConditionButton')}
                    </button>
                    <span className={styles.hint}>
                      {t('queryBuilder.conditionsHint1')}
                      <code>and</code>
                      {t('queryBuilder.conditionsHint2')}
                      <code>or</code>
                      {t('queryBuilder.conditionsHint3')}
                      <code>not</code>
                      {t('queryBuilder.conditionsHint4')}
                    </span>
                  </div>

                  <div className={styles.sortRow}>
                    <label className={styles.label} htmlFor="query-sort">
                      {t('queryBuilder.sortLabel')}
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
                          {f.name}{t('queryBuilder.slotColumnSuffix')}
                        </option>
                      ))}
                    </select>

                    <select
                      className={styles.select}
                      aria-label={t('queryBuilder.sortDirectionAriaLabel')}
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
                      <option value="asc">{t('queryBuilder.ascending')}</option>
                      <option value="desc">{t('queryBuilder.descending')}</option>
                    </select>

                    <label className={styles.label} htmlFor="query-page-size">
                      {t('queryBuilder.pageSizeLabel')}
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
                      {t('queryBuilder.clearButton')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => dispatch({ type: 'query/run' })}
                    >
                      {t('queryBuilder.runButton')}
                    </button>
                  </div>

                  <p className={styles.sortNote}>
                    {t('queryBuilder.sortNote1')}
                    <strong>{t('queryBuilder.sortNoteBold')}</strong>
                    {t('queryBuilder.sortNote2')}
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
                title={t('queryBuilder.apiLogTitle')}
                note="source=api"
                height="200px"
                empty={
                  <>
                    {t('queryBuilder.apiLogEmpty1')}
                    <code>search_request</code>
                    {t('queryBuilder.apiLogEmpty2')}
                    <code>pre_flight_rejected</code>
                    {t('queryBuilder.apiLogEmpty3')}
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
