'use client';

import { useCallback, useMemo, useState } from 'react';
import CodeBlock from '@/components/CodeBlock';
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
const TYPE_SUFFIX: Record<DeclaredType, string> = {
  string: ', indexed on a 766-character prefix',
  int: '',
  numeric: '',
  datetime: '',
};

function typeBlurb(declaredType: DeclaredType): string {
  return `${slotSqlType(declaredType)}${TYPE_SUFFIX[declaredType]}`;
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
      setStatus(`${draft.fields[from]?.name ?? 'field'} moved to position ${to + 1} of ${draft.fields.length}.`);
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
    setStatus(`${field.name} moved to position ${to + 1} of ${draft.fields.length}.`);
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
    <section className={styles.section} id="define" aria-labelledby="define-title">
      <p className="eyebrow">section a</p>
      <h2 id="define-title" className={styles.title}>
        Define your models
      </h2>
      <p className="section-lede">
        Add fields, name them, decide which ones you will want to filter on. Your tenants
        do this at runtime and it never runs an <code>ALTER TABLE</code> — a field is a
        row in <code>stardust_fields</code>, not a column in your schema.
      </p>

      <div className={styles.grid}>
        <div className={styles.builder}>
          <div className={`panel ${styles.palette}`}>
            <div className="panel-head">
              <span>field types</span>
              <span className="tag tag-json">declared_type ENUM</span>
            </div>
            <div className={styles.paletteBody}>
              <p className={styles.hint}>
                Click to add one, or drag it into the list to place it exactly.
              </p>
              <div className={styles.chips}>
                {DECLARED_TYPES.map(t => (
                  <button
                    key={t}
                    type="button"
                    className={styles.chip}
                    onPointerDown={start({ kind: 'palette', declaredType: t })}
                    {...handlers}
                    // The real action, and the only one a keyboard can reach:
                    // Enter and Space produce a click and never a pointerup.
                    // A drag that ended here already inserted the field, and
                    // `ignoreClick()` is what stops it being added twice.
                    onClick={() => {
                      if (ignoreClick()) return;
                      dispatch({ type: 'draft/addField', declaredType: t });
                    }}
                  >
                    <span className={styles.chipName}>{t}</span>
                    <span className={styles.chipNote}>{typeBlurb(t)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className={`panel ${styles.card}`}>
            <div className="panel-head">
              <span>{draft.modelId === null ? 'new model' : `model #${draft.modelId}`}</span>
              <span className="tag tag-json">uncommitted</span>
            </div>

            <div className={styles.cardBody}>
              <label className={styles.nameLabel}>
                <span>model name</span>
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
                  <p className={styles.empty}>
                    No fields yet. A model with no fields is perfectly legal — it just
                    stores nothing but ids and timestamps until you add one.
                  </p>
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
                  The greyed rows are already in <code>stardust_fields</code>.{' '}
                  <code>createModel()</code> is get-or-create — it can <em>add</em>{' '}
                  fields to this model and nothing else. Changing one is a different
                  call each time: <code>renameField()</code>, <code>retypeField()</code>,{' '}
                  <code>promoteFieldToFilterable()</code> and <code>deleteField()</code>{' '}
                  are separate operations, every one of them a migration that runs over
                  live data rather than an edit that lands instantly. They get their own
                  section, with the daemons visible while they drain.
                </p>
              )}

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
                  new model
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
            title="what your application would call"
            copyable
          />
          <p className={styles.aside}>
            <strong>Filterable is intent, not an index.</strong> It sets one boolean in
            the registry. No page is provisioned and no slot is reserved — that is a
            daemon&rsquo;s job, and until it happens a filter on the field is rejected
            rather than answered slowly.
          </p>
        </div>
      </div>

      <p className={styles.srOnly} role="status" aria-live="polite">
        {status}
      </p>

      {committed.length > 0 && (
        <div className={styles.committed}>
          <h3 className={styles.committedTitle}>Committed to the registry</h3>
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
                    add fields
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
                            indexed
                          </span>
                        ) : (
                          <span className="tag tag-pending">
                            <span className="dot" />
                            filterable · not indexed yet
                          </span>
                        )
                      ) : (
                        <span className="tag tag-json">JSON only</span>
                      )}
                    </div>
                  ))}
                  {fieldsOf(world, model.id).length === 0 && (
                    <p className={styles.dim}>No fields on this model.</p>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p className={styles.orderNote}>
            Fields are listed in id order, which is the only order there is —{' '}
            <code>stardust_fields</code> has no sort column. Whatever order you dragged
            them into was an argument to one call, and it did not survive the insert.
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
  const parts: string[] = [];

  parts.push(
    summary.modelInserted
      ? `Inserted model #${summary.modelId}.`
      : `Model #${summary.modelId} already existed — returned unchanged.`,
  );

  if (summary.fieldsInserted.length > 0) {
    parts.push(`Inserted ${summary.fieldsInserted.join(', ')}.`);
  }
  if (summary.fieldsExisting.length > 0) {
    parts.push(
      `${summary.fieldsExisting.join(', ')} already existed and ${
        summary.fieldsExisting.length === 1 ? 'was' : 'were'
      } left exactly as stored — an existing field's type and filterability are never reconciled against the arguments.`,
    );
  }

  parts.push(
    summary.versionBumped
      ? `stardust_schema_version bumped to ${schemaVersion}.`
      : 'Nothing was inserted, so stardust_schema_version was not bumped.',
  );

  return (
    <p className={summary.versionBumped ? styles.commit : styles.commitQuiet}>
      {parts.join(' ')}
    </p>
  );
}
