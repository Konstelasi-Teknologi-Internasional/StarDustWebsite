'use client';

import { useCallback, useMemo, useState } from 'react';
import CodeBlock from '@/components/CodeBlock';
import { useTranslations } from '@/lib/i18n';
import { usePointerDrag } from '@/lib/usePointerDrag';
import { slotSqlType } from '@/lib/sim/ddl';
import type { CommitSummary, DraftField } from '@/lib/sim/draft';
import { createModelSnippetFull } from '@/lib/sim/php';
import { DECLARED_TYPES } from '@/lib/sim/registry';
import type { DeclaredType } from '@/lib/sim/types';
import { fieldIndexState, fieldsOf } from '@/lib/sim/world';
import DraftFieldRow from './DraftFieldRow';
import { usePlayground } from './PlaygroundContext';
import styles from './ModelBuilder.module.css';

type Translate = ReturnType<typeof useTranslations>;

/** What a drag is carrying: a new field from the palette, or an existing row. */
type Payload =
  | { kind: 'palette'; declaredType: DeclaredType }
  | { kind: 'row'; index: number };

/**
 * What each type costs, beyond the column type itself.
 *
 * The column type is **not** repeated here — `slotSqlType()` owns that, and
 * this map used to carry its own copy which had quietly drifted to `DECIMAL`
 * for `numeric` where the engine provisions `DOUBLE`. A component encoding a
 * rule about slot columns is exactly what the one-simulation-core rule
 * forbids, and this is what it looks like when it goes wrong.
 */
const TYPE_SUFFIX_KEY: Partial<Record<DeclaredType, string>> = {
  string: 'modelBuilder.stringIndexSuffix',
};

function typeBlurb(declaredType: DeclaredType, t: Translate): string {
  const key = TYPE_SUFFIX_KEY[declaredType];
  return `${slotSqlType(declaredType)}${key ? t(key) : ''}`;
}

/**
 * Section A — define your models.
 *
 * Nothing here writes a row until "create model" is pressed, because nothing
 * in the engine does either: `createModel()` validates every argument, opens
 * one transaction, and commits the model and all its fields together. Up to
 * that point a visitor is assembling arguments, which is why the draft is a
 * draft and not a table.
 *
 * Two facts this section exists to make unmissable:
 *
 * 1. Fields are defined at runtime by tenants, with no `ALTER TABLE`. That is
 *    the premise the entire library rests on.
 * 2. Marking a field filterable is *intent*. It writes `is_filterable = 1` to
 *    the registry and does nothing else — no page, no slot, no index. The
 *    "not indexed yet" marker on every committed field says so, and it will
 *    still be saying so in the daemon section until something provisions
 *    capacity and reserves the slot.
 */
export default function ModelBuilder() {
  const { world, dispatch } = usePlayground();
  const { draft } = world;
  const t = useTranslations('playground');

  // Announced rather than shown: a reorder done from the keyboard produces no
  // visual event a screen reader would otherwise report.
  const [status, setStatus] = useState('');

  const onDrop = useCallback(
    (payload: Payload, insertIndex: number) => {
      if (payload.kind === 'palette') {
        dispatch({ type: 'draft/addField', declaredType: payload.declaredType, at: insertIndex });
        return;
      }

      // `insertIndex` is a gap in the list as it stands; `draft/moveField`
      // removes first and then inserts, so a gap after the moved row is one
      // position further left once that row is gone.
      const from = payload.index;
      const to = insertIndex > from ? insertIndex - 1 : insertIndex;
      if (to === from) return;

      dispatch({ type: 'draft/moveField', from, to });
      setStatus(
        t('modelBuilder.statusMoved', {
          field: draft.fields[from]?.name ?? 'field',
          to: to + 1,
          total: draft.fields.length,
        }),
      );
      // `t` is deliberately not a dependency — see `useNarration`'s comment on
      // the same point: `useTranslations` hands back a new function every
      // render, and the locale it is bound to never changes for the life of
      // this component.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [dispatch, draft.fields],
  );

  const { drag, start, registerRow, ignoreClick, handlers } = usePointerDrag<Payload>({
    rowCount: draft.fields.length,
    onDrop,
  });

  const snippet = useMemo(
    () => createModelSnippetFull(draft, world.tenantId),
    [draft, world.tenantId],
  );

  const move = (field: DraftField, from: number) => (to: number) => {
    dispatch({ type: 'draft/moveField', from, to });
    setStatus(
      t('modelBuilder.statusMoved', { field: field.name, to: to + 1, total: draft.fields.length }),
    );
  };

  const committed = world.models.filter(m => m.deletedAt === null);

  // A draft row is locked when the registry already has a field of that name
  // on the model this draft is bound to. Matching on name is safe because the
  // draft cannot hold two rows with the same one.
  const committedNames = useMemo(() => {
    if (draft.modelId === null) return new Set<string>();
    return new Set(fieldsOf(world, draft.modelId).map(f => f.name));
  }, [world, draft.modelId]);

  const hasLocked = draft.fields.some(f => committedNames.has(f.name));

  return (
    <section className={styles.section} id="define" aria-labelledby="define-title" tabIndex={-1}>
      <p className="eyebrow">{t('modelBuilder.eyebrow')}</p>
      <h2 id="define-title" className={styles.title}>
        {t('modelBuilder.title')}
      </h2>
      <p className="section-lede">
        {t('modelBuilder.lede1')}
        <code>ALTER TABLE</code>
        {t('modelBuilder.lede2')}
        <code>stardust_fields</code>
        {t('modelBuilder.lede3')}
      </p>

      <div className={styles.grid}>
        <div className={styles.builder}>
          <div className={`panel ${styles.palette}`}>
            <div className="panel-head">
              <span>{t('modelBuilder.paletteTitle')}</span>
              <span className="tag tag-json">declared_type ENUM</span>
            </div>
            <div className={styles.paletteBody}>
              <p className={styles.hint}>{t('modelBuilder.paletteHint')}</p>
              <div className={styles.chips}>
                {DECLARED_TYPES.map(type => (
                  <button
                    key={type}
                    type="button"
                    className={styles.chip}
                    onPointerDown={start({ kind: 'palette', declaredType: type })}
                    {...handlers}
                    // The real action, and the only one a keyboard can reach:
                    // Enter and Space produce a click and never a pointerup.
                    // A drag that ended here already inserted the field, and
                    // `ignoreClick()` is what stops it being added twice.
                    onClick={() => {
                      if (ignoreClick()) return;
                      dispatch({ type: 'draft/addField', declaredType: type });
                    }}
                  >
                    <span className={styles.chipName}>{type}</span>
                    <span className={styles.chipNote}>{typeBlurb(type, t)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className={`panel ${styles.card}`}>
            <div className="panel-head">
              <span>
                {draft.modelId === null
                  ? t('modelBuilder.newModelLabel')
                  : t('modelBuilder.modelIdLabel', { id: draft.modelId })}
              </span>
              <span className="tag tag-json">{t('modelBuilder.uncommitted')}</span>
            </div>

            <div className={styles.cardBody}>
              <label className={styles.nameLabel}>
                <span>{t('modelBuilder.modelNameLabel')}</span>
                <input
                  className={styles.modelName}
                  value={draft.name}
                  spellCheck={false}
                  placeholder="products"
                  onChange={e => dispatch({ type: 'draft/setName', name: e.target.value })}
                />
              </label>

              <div className={styles.rows}>
                {draft.fields.length === 0 && (
                  <p className={styles.empty}>{t('modelBuilder.noFieldsYet')}</p>
                )}

                {draft.fields.map((field, i) => (
                  <div key={field.key} className={styles.rowSlot} ref={registerRow(i)}>
                    {drag !== null && drag.insertIndex === i && (
                      <span className={styles.insertLine} aria-hidden="true" />
                    )}
                    <DraftFieldRow
                      field={field}
                      index={i}
                      count={draft.fields.length}
                      dragging={drag?.payload.kind === 'row' && drag.payload.index === i}
                      locked={committedNames.has(field.name)}
                      onPatch={patch => dispatch({ type: 'draft/patchField', key: field.key, patch })}
                      onRemove={() => dispatch({ type: 'draft/removeField', key: field.key })}
                      onMove={move(field, i)}
                      onGripDown={start({ kind: 'row', index: i })}
                      gripHandlers={handlers}
                    />
                  </div>
                ))}

                {drag !== null && drag.insertIndex === draft.fields.length && (
                  <span className={styles.insertLine} aria-hidden="true" />
                )}
              </div>

              {hasLocked && (
                <p className={styles.lockNote}>
                  {t('modelBuilder.lockNoteP1')}
                  <code>stardust_fields</code>
                  {t('modelBuilder.lockNoteP2')}
                  <code>createModel()</code>
                  {t('modelBuilder.lockNoteP3')}
                  <em>{t('modelBuilder.lockNoteAdd')}</em>
                  {t('modelBuilder.lockNoteP4')}
                  <code>renameField()</code>
                  {t('modelBuilder.lockNoteP5')}
                  <code>retypeField()</code>
                  {t('modelBuilder.lockNoteP6')}
                  <code>promoteFieldToFilterable()</code>
                  {t('modelBuilder.lockNoteP7')}
                  <code>deleteField()</code>
                  {t('modelBuilder.lockNoteP8')}
                </p>
              )}

              {/* `draft.error` simulates the message a real InvalidArgumentException
                  would carry — the engine has no i18n, so it stays in English in
                  both locales, on the same fidelity rule as `SimulationNotice`. */}
              {draft.error !== null && (
                <p className={styles.error} role="alert">
                  {draft.error}
                </p>
              )}

              <div className={styles.actions}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => dispatch({ type: 'registry/createModel' })}
                >
                  createModel()
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => dispatch({ type: 'draft/reset' })}
                >
                  {t('modelBuilder.newModelButton')}
                </button>
              </div>

              {draft.lastCommit !== null && (
                <CommitNote
                  summary={draft.lastCommit}
                  schemaVersion={world.schemaVersion}
                />
              )}
            </div>
          </div>
        </div>

        <div className={styles.side}>
          <CodeBlock
            code={snippet}
            lang="php"
            title={t('modelBuilder.sideCodeTitle')}
            copyable
          />
          <p className={styles.aside}>
            <strong>{t('modelBuilder.asideBold')}</strong>
            {t('modelBuilder.asideRest')}
          </p>
        </div>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>

      {committed.length > 0 && (
        <div className={styles.committed}>
          <h3 className={styles.committedTitle}>{t('modelBuilder.committedTitle')}</h3>
          <div className={styles.models}>
            {committed.map(model => (
              <div key={model.id} className={`panel ${styles.model}`}>
                <div className="panel-head">
                  <span>
                    {model.name} <span className={styles.dim}>· id {model.id}</span>
                  </span>
                  <button
                    type="button"
                    className={styles.reopen}
                    onClick={() => dispatch({ type: 'draft/loadModel', modelId: model.id })}
                  >
                    {t('modelBuilder.reopenButton')}
                  </button>
                </div>
                <div className={styles.modelBody}>
                  {fieldsOf(world, model.id).map(f => (
                    <div key={f.id} className={styles.modelField}>
                      <span className={styles.modelFieldName}>{f.name}</span>
                      <span className="tag">{f.declaredType}</span>
                      {f.isFilterable ? (
                        fieldIndexState(world, f.id) === 'live' ? (
                          <span className="tag tag-indexed">
                            <span className="dot" />
                            {t('modelBuilder.indexedTag')}
                          </span>
                        ) : (
                          <span className="tag tag-pending">
                            <span className="dot" />
                            {t('modelBuilder.pendingTag')}
                          </span>
                        )
                      ) : (
                        <span className="tag tag-json">{t('modelBuilder.jsonOnlyTag')}</span>
                      )}
                    </div>
                  ))}
                  {fieldsOf(world, model.id).length === 0 && (
                    <p className={styles.dim}>{t('modelBuilder.noFieldsOnModel')}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p className={styles.orderNote}>
            {t('modelBuilder.orderNote1')}
            <code>stardust_fields</code>
            {t('modelBuilder.orderNote2')}
          </p>
        </div>
      )}

      {drag !== null && (
        <span
          className={styles.ghost}
          style={{ left: drag.x, top: drag.y }}
          aria-hidden="true"
        >
          {drag.payload.kind === 'palette'
            ? drag.payload.declaredType
            : (draft.fields[drag.payload.index]?.name ?? 'field')}
        </span>
      )}
    </section>
  );
}

/**
 * What the commit actually did.
 *
 * This is the section's second lesson and it only lands if the numbers are
 * shown rather than described: pressing `createModel()` twice inserts nothing
 * the second time and does not bump the schema version, because every method
 * on the builder is get-or-create.
 */
function CommitNote({
  summary,
  schemaVersion,
}: {
  summary: CommitSummary;
  schemaVersion: number;
}) {
  const t = useTranslations('playground');
  const parts: string[] = [];

  parts.push(
    summary.modelInserted
      ? t('modelBuilder.commit.insertedModel', { id: summary.modelId })
      : t('modelBuilder.commit.modelExisted', { id: summary.modelId }),
  );

  if (summary.fieldsInserted.length > 0) {
    parts.push(t('modelBuilder.commit.insertedFields', { names: summary.fieldsInserted.join(', ') }));
  }
  if (summary.fieldsExisting.length > 0) {
    parts.push(
      t(
        summary.fieldsExisting.length === 1
          ? 'modelBuilder.commit.fieldsExistedSingular'
          : 'modelBuilder.commit.fieldsExistedPlural',
        { names: summary.fieldsExisting.join(', ') },
      ),
    );
  }

  parts.push(
    summary.versionBumped
      ? t('modelBuilder.commit.versionBumped', { version: schemaVersion })
      : t('modelBuilder.commit.versionNotBumped'),
  );

  return (
    <p className={summary.versionBumped ? styles.commit : styles.commitQuiet}>
      {parts.join(' ')}
    </p>
  );
}
