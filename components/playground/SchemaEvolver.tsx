'use client';

import { useState } from 'react';
import CodeBlock from '@/components/CodeBlock';
import { useTranslations } from '@/lib/i18n';
import { isCategoricallyRejected } from '@/lib/sim/backfill';
import { checkpointFor } from '@/lib/sim/checkpoints';
import { fieldPurgeCheckpoint, runningModelPurge } from '@/lib/sim/delete';
import {
  deleteFieldSnippet,
  deleteModelSnippet,
  renameFieldSnippet,
  renameModelSnippet,
  retypeFieldSnippet,
} from '@/lib/sim/php';
import { DECLARED_TYPES } from '@/lib/sim/registry';
import { runningCheckpointForField } from '@/lib/sim/retype';
import type { DeclaredType, SimField, SimModel } from '@/lib/sim/types';
import { fieldsOf, type LifecycleOutcome } from '@/lib/sim/world';
import CheckpointBar from './CheckpointBar';
import EventLog from './EventLog';
import { usePlayground } from './PlaygroundContext';
import styles from './SchemaEvolver.module.css';

/**
 * The lifecycles this section drives, so its feedback line does not print
 * section D's refusals — see the comment at the render site.
 */
const OWNED_ACTIONS = new Set<LifecycleOutcome['action']>([
  'retype',
  'rename-field',
  'rename-model',
  'delete-field',
  'delete-model',
]);

/**
 * Section F — schema change while the data is live.
 *
 * The deepest thing the engine does, and the one nothing else on the site shows
 * at all. Every other section demonstrates a state; this one demonstrates a
 * **window** — an interval during which the registry says one thing, storage
 * still says another, and every surface has to be correct anyway.
 *
 * Two calls with the same shape, and the contrast is the lesson:
 *
 *   - `renameModel()` is a label change. Identity is `stardust_models.id`, no
 *     snapshot holds a model name, and the call is complete before it returns.
 *   - `renameField()` is a migration. `entry_data.fields` is keyed by field
 *     **name**, so flipping the registry changes what every stored payload
 *     *should* say and none of what it does say — and the rewrite is the
 *     Reconciler's, in chunks, over every row in the model.
 *
 * Stop the Reconciler before you rename and the window stays open for as long
 * as you like. That is the whole affordance: `previous_name` non-null in the
 * table inspector, half the payloads on the old key, and a read that returns
 * correct rows throughout.
 */
export default function SchemaEvolver() {
  const { world } = usePlayground();
  const t = useTranslations('playground');

  return (
    <section className={styles.section} id="evolve" aria-labelledby="evolve-title" tabIndex={-1}>
      <p className="eyebrow">{t('schemaEvolver.eyebrow')}</p>
      <h2 id="evolve-title" className={styles.title}>
        {t('schemaEvolver.heading')}
      </h2>
      <p className="section-lede">{t('schemaEvolver.lede')}</p>

      <div className={styles.beats}>
        <div className={styles.beat}>
          <h3 className={styles.beatTitle}>{t('schemaEvolver.beat1Title')}</h3>
          <p>
            {t('schemaEvolver.beat1Body1')}
            <em>{t('schemaEvolver.beat1During')}</em>
            {t('schemaEvolver.beat1Body2')}
          </p>
        </div>
        <div className={styles.beat}>
          <h3 className={styles.beatTitle}>{t('schemaEvolver.beat2Title')}</h3>
          <p>
            {t('schemaEvolver.beat2Body1')}
            <em>{t('schemaEvolver.beat2Filter')}</em>
            {t('schemaEvolver.beat2Body2')}
          </p>
        </div>
      </div>

      {world.models.length === 0 ? (
        <div className={`panel ${styles.empty}`}>
          <p>{t('schemaEvolver.emptyBody')}</p>
        </div>
      ) : (
        <div className={styles.stack}>
          {world.models.map(model => (
            <ModelPanel key={model.id} model={model} />
          ))}
        </div>
      )}

      {/* The mirror image of the filter in `FieldIndexReadout`: this section
          owns the four schema-change lifecycles, and section D owns promote and
          demote. One slot on the world, six writers, so each renderer says
          which of them it speaks for. */}
      {/* Simulates the message a real lifecycle exception would carry —
          untranslated in both locales, same fidelity rule as `draft.error`. */}
      {world.lastLifecycle?.error != null && OWNED_ACTIONS.has(world.lastLifecycle.action) && (
        <p className={styles.error} role="status">
          {world.lastLifecycle.error}
        </p>
      )}

      {/* A deletion that did nothing. Worth its own line precisely because the
          engine makes "does not exist", "belongs to another tenant" and
          "already being deleted" indistinguishable — nothing changes and
          nothing is logged, so without this a visitor could not tell a no-op
          from a failure. The cost of that design is that a typo in an id is
          silent, and this is what makes it audible here. */}
      {/* Filtered to `registry`, which is not a convenience — it is this
          section's subject. Every lifecycle transition here is emitted on that
          source (`rename_started`, `delete_started`, `model_renamed`,
          `rename_complete`, `promote_to_ready`, …) while the chunk-by-chunk
          drain that carries it out is `reconciler`. Section D's log is
          deliberately unfiltered because the interleaving *is* its point; here
          the interleaving would bury eight lines that matter under five hundred
          that do not. The progress bars above are the drain's voice. */}
      {/* `EventLog` has no margin of its own — every caller wraps it, since
          section D's does the same via `.split`. Without this it sits flush
          against the last model panel, with none of the gap every other card
          in this section gets. */}
      <div className={styles.log}>
        <EventLog
          events={world.events}
          sources={['registry']}
          height="260px"
          title={t('schemaEvolver.logTitle')}
          note={t('schemaEvolver.logNote')}
          empty={t('schemaEvolver.logEmpty')}
        />
      </div>

      {world.lastLifecycle?.noop === true && OWNED_ACTIONS.has(world.lastLifecycle.action) && (
        <p className={styles.noop} role="status">
          {t('schemaEvolver.noopBody1')}
          <code>false</code>
          {t('schemaEvolver.noopBody2')}
        </p>
      )}
    </section>
  );
}

function ModelPanel({ model }: { model: SimModel }) {
  const { world, dispatch } = usePlayground();
  const fields = fieldsOf(world, model.id);
  const t = useTranslations('playground');

  const purging = runningModelPurge(world, model.id);
  const remaining = world.entries.filter(
    e => e.modelId === model.id && e.tenantId === world.tenantId,
  ).length;

  if (purging !== undefined) {
    return (
      <div className={`panel ${styles.panel}`}>
        <div className="panel-head">
          <span>
            {model.name} · model {model.id}
          </span>
          <span className="tag tag-error">
            <span className="dot" />
            {t('schemaEvolver.purgingTag')}
          </span>
        </div>

        <div className={styles.window}>
          <div className={styles.windowCounts}>
            <span className={styles.count}>
              <strong>{remaining}</strong> {t('schemaEvolver.rowsLeftToDestroy')}
            </span>
            <span className={styles.count}>
              <strong>{fields.length}</strong> {t('schemaEvolver.fieldsStillVisible')}
            </span>
          </div>
          <CheckpointBar
            checkpoint={purging}
            total={remaining}
            totalNote={t('schemaEvolver.modelPurgeTotalNote')}
          />
          <p className={styles.footnote}>
            <strong>{t('schemaEvolver.modelDarkBold')}</strong>
            {t('schemaEvolver.modelDarkBody1')}
            <em>{t('schemaEvolver.modelDarkRefused')}</em>
            {t('schemaEvolver.modelDarkBody2')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`panel ${styles.panel}`}>
      <div className="panel-head">
        <span>
          {model.name} · model {model.id}
        </span>
        <span className="tag tag-json">
          {t('schemaEvolver.modelTenantTag', { tenantId: world.tenantId })}
        </span>
      </div>

      <div className={styles.modelRename}>
        <RenameControl
          label={t('schemaEvolver.renameModelLabel')}
          current={model.name}
          hint={t('schemaEvolver.renameModelHint')}
          onSubmit={name => dispatch({ type: 'model/rename', modelId: model.id, name })}
        />
        <p className={styles.footnote}>
          {t('schemaEvolver.renameModelFootnote1')}
          <strong>{t('schemaEvolver.renameModelFootnoteNot')}</strong>
          {t('schemaEvolver.renameModelFootnote2')}
          <code>backfill_checkpoints</code>
          {t('schemaEvolver.renameModelFootnote3')}
          <code>stardust_schema_version</code>
          {t('schemaEvolver.renameModelFootnote4')}
          <code>createModel()</code>
          {t('schemaEvolver.renameModelFootnote5')}
        </p>
        {/* Shown next to the field snippet further down on purpose: two calls
            with the same shape, one of which is a migration and one of which is
            a label change. */}
        <CodeBlock
          lang="php"
          title={t('schemaEvolver.callTitle')}
          code={renameModelSnippet(world.tenantId, model.id, model.name, model.name)}
        />
      </div>

      <div className={styles.rows}>
        {fields.map(field => (
          <FieldRow key={field.id} field={field} model={model} />
        ))}
        {/* Deliberately read straight off `world.fields` rather than through
            `fieldsOf()`, which excludes them — that exclusion is the behaviour
            every other section is demonstrating, and this is the one place that
            has to show what it is hiding. */}
        {world.fields
          .filter(f => f.modelId === model.id && f.deletedAt !== null)
          .map(field => (
            <PurgingFieldRow key={field.id} field={field} />
          ))}
      </div>

      <div className={`${styles.danger} ${styles.modelDanger}`}>
        <DangerButton
          label={t('schemaEvolver.deleteModelLabel')}
          confirm={t('schemaEvolver.deleteModelConfirm', { count: remaining })}
          onConfirm={() => dispatch({ type: 'model/delete', modelId: model.id })}
        />
        <p className={styles.footnote}>
          <strong>
            {t('schemaEvolver.deleteModelFootnoteBold1')}
            <code>entry_data</code>
            {t('schemaEvolver.deleteModelFootnoteBold2')}
          </strong>
          {t('schemaEvolver.deleteModelFootnote1')}
          <code>stardust_sync_queue</code>
          {t('schemaEvolver.deleteModelFootnote2')}
        </p>
        <CodeBlock
          lang="php"
          title={t('schemaEvolver.callTitle')}
          code={deleteModelSnippet(world.tenantId, model.id, model.name)}
        />
      </div>
    </div>
  );
}

function FieldRow({ field, model }: { field: SimField; model: SimModel }) {
  const { world, dispatch } = usePlayground();
  const t = useTranslations('playground');

  const renaming = checkpointFor(world, 'rename', field.id);
  const inFlight = renaming?.status === 'running' && field.previousName !== null;
  const retyping = runningCheckpointForField(world, field.id);

  const entriesInModel = world.entries.filter(
    e => e.modelId === field.modelId && e.tenantId === world.tenantId,
  ).length;

  // Counted off the stored payloads rather than off the cursor. The cursor is an
  // entry **id**, so on a partition with gaps it is not a row count — and these
  // two numbers are the thing the section exists to show anyway.
  const stale = inFlight
    ? world.entries.filter(
        e => e.modelId === model.id && field.previousName !== null && field.previousName in e.fields,
      ).length
    : 0;
  const migrated = inFlight
    ? world.entries.filter(e => e.modelId === model.id && field.name in e.fields).length
    : 0;

  return (
    <div className={styles.row}>
      <div className={styles.head}>
        <span className={styles.field}>
          {field.name}
          <em>{field.declaredType}</em>
        </span>
        {field.previousName !== null && (
          <span className="tag tag-pending">
            <span className="dot" />
            {t('schemaEvolver.previousNameTag', { name: field.previousName })}
          </span>
        )}
      </div>

      <RenameControl
        label={t('schemaEvolver.renameFieldLabel')}
        current={field.name}
        disabled={inFlight || retyping !== undefined}
        hint={
          inFlight
            ? t('schemaEvolver.renameInFlightHint')
            : retyping !== undefined
              ? t('schemaEvolver.retypeInFlightHint')
              : t('schemaEvolver.renameReadyHint')
        }
        onSubmit={name => dispatch({ type: 'field/rename', fieldId: field.id, name })}
      />

      {inFlight && field.previousName !== null && (
        <div className={styles.window}>
          <div className={styles.windowCounts}>
            <span className={styles.count}>
              <strong>{migrated}</strong> {t('schemaEvolver.rewrittenTo', { name: field.name })}
            </span>
            <span className={styles.count}>
              <strong>{stale}</strong>{' '}
              {t('schemaEvolver.stillStoredAs', { name: field.previousName })}
            </span>
          </div>
          <CheckpointBar
            checkpoint={renaming}
            total={entriesInModel}
            totalNote={t('schemaEvolver.renameTotalNote', { total: entriesInModel })}
          />
          <p className={styles.footnote}>
            {t('schemaEvolver.renameWindowFootnote1', { total: entriesInModel })}
            <code>{field.name}</code>
            {t('schemaEvolver.renameWindowFootnote2', { stale })}
            <code>{field.previousName}</code>
            {t('schemaEvolver.renameWindowFootnote3')}
            <code>{field.previousName}</code>
            {t('schemaEvolver.renameWindowFootnote4')}
          </p>
        </div>
      )}

      <RetypeControl field={field} disabled={inFlight || retyping !== undefined} />

      <div className={styles.danger}>
        <DangerButton
          label={t('schemaEvolver.deleteFieldLabel', { name: field.name })}
          confirm={t('schemaEvolver.deleteFieldConfirm')}
          disabled={inFlight || retyping !== undefined}
          onConfirm={() => dispatch({ type: 'field/delete', fieldId: field.id })}
        />
        <p className={styles.footnote}>
          {t('schemaEvolver.deleteFieldFootnote1')}
          <strong>{t('schemaEvolver.deleteFieldNotReusable')}</strong>
          {t('schemaEvolver.deleteFieldFootnote2')}
          <code>ux_fields_model_name</code>
          {t('schemaEvolver.deleteFieldFootnote3')}
        </p>
      </div>

      {/* One block for the row rather than one per control. Three lifecycles
          act on one field and the section's lesson is how differently they
          behave, so seeing the three calls together is worth more than seeing
          each beside its own button — and three CodeBlocks per field would
          bury the controls. While something is draining it narrows to that one
          call, because then the interesting thing is not the menu. */}
      <CodeBlock
        lang="php"
        title={inFlight ? t('schemaEvolver.inFlightTitle') : t('schemaEvolver.whatRowCanCall')}
        code={
          inFlight
            ? renameFieldSnippet(
                world.tenantId,
                field.id,
                field.previousName ?? field.name,
                field.name,
              )
            : [
                renameFieldSnippet(world.tenantId, field.id, field.name, `${field.name}_v2`),
                retypeFieldSnippet(
                  world.tenantId,
                  field.id,
                  field.declaredType,
                  firstAllowedTarget(field.declaredType),
                ),
                deleteFieldSnippet(world.tenantId, field.id, field.name),
              ].join('\n\n')
        }
      />
    </div>
  );
}

/**
 * The ADR 0024 matrix, as four buttons.
 *
 * A retype is the same registry tuple a promotion runs, with the *other* target
 * moved — so it tombstones the old slot, reserves a replacement **in the new
 * type's family**, and drains every value in the model through one matrix cell.
 * On a fresh page that means the cold start again: the new family has no indexed
 * column, so the reservation is deferred and the Watcher has to provision.
 *
 * The four refused cells are rendered as refused rather than hidden. `int` and
 * `numeric` cannot become `datetime` and back, because there is no defensible
 * answer to "what integer is this timestamp" — seconds since the epoch,
 * milliseconds, a packed `YYYYMMDD` and a Julian day are all reasonable and all
 * different. A greyed button that says why teaches that; an absent one teaches
 * that the feature is unfinished.
 */
function RetypeControl({ field, disabled }: { field: SimField; disabled: boolean }) {
  const { dispatch } = usePlayground();
  const t = useTranslations('playground');

  return (
    <div className={styles.retype}>
      <span className={styles.controlLabelInline}>{t('schemaEvolver.retypeToLabel')}</span>
      <div className={styles.types}>
        {DECLARED_TYPES.map(type => {
          const rejected = isCategoricallyRejected(field.declaredType, type);
          const current = type === field.declaredType;
          return (
            <button
              key={type}
              type="button"
              className="btn"
              disabled={disabled || rejected || current}
              onClick={() =>
                dispatch({ type: 'field/retype', fieldId: field.id, declaredType: type })
              }
              title={
                current
                  ? t('schemaEvolver.alreadyThisType')
                  : rejected
                    ? t('schemaEvolver.retypeRejectedTitle', { from: field.declaredType, to: type })
                    : t('schemaEvolver.retypeAllowedTitle', { from: field.declaredType, to: type })
              }
            >
              {type}
            </button>
          );
        })}
      </div>
      <span className={styles.hint}>
        {t('schemaEvolver.retypeHint1')}
        <strong>{t('schemaEvolver.retypeHintNew')}</strong>
        {t('schemaEvolver.retypeHint2')}
        <code>NULL</code>
        {t('schemaEvolver.retypeHint3')}
        <code>2.5</code>
        {t('schemaEvolver.retypeHint4')}
        <code>int</code>
        {t('schemaEvolver.retypeHint5')}
        <code>coercion_null</code>
        {t('schemaEvolver.retypeHint6')}
        <code>2</code>
        {t('schemaEvolver.retypeHint7')}
      </span>
    </div>
  );
}

/**
 * A type this field could legally be retyped to, for the illustrative snippet.
 *
 * It has to consult the matrix rather than pick a favourite: `int` and
 * `numeric` cannot become `datetime`, so a hardcoded example would render a
 * call the engine refuses, in the one panel claiming to show what the buttons
 * do.
 */
function firstAllowedTarget(from: DeclaredType): DeclaredType {
  return (
    DECLARED_TYPES.find(to => to !== from && !isCategoricallyRejected(from, to)) ?? 'string'
  );
}

/**
 * A field whose deletion is draining — no longer in `fieldsOf()`, so it needs
 * its own row above the surviving ones.
 *
 * It exists at all because this section is the one place that should show what
 * every *other* surface is hiding. The point of severance is that a deleted
 * field is invisible everywhere the instant the call returns; the point of this
 * row is that its values are demonstrably still in storage while that is true.
 */
function PurgingFieldRow({ field }: { field: SimField }) {
  const { world } = usePlayground();
  const t = useTranslations('playground');

  const checkpoint = fieldPurgeCheckpoint(world, field.id);
  if (checkpoint === undefined || checkpoint.status !== 'running') return null;

  const total = world.entries.filter(
    e => e.modelId === field.modelId && e.tenantId === world.tenantId,
  ).length;
  const residual = world.entries.filter(
    e => e.modelId === field.modelId && field.name in e.fields,
  ).length;

  return (
    <div className={styles.row}>
      <div className={styles.head}>
        <span className={styles.field}>
          {field.name}
          <em>{field.declaredType}</em>
        </span>
        <span className="tag tag-error">
          <span className="dot" />
          {t('schemaEvolver.purgingTag')}
        </span>
      </div>

      <div className={styles.window}>
        <div className={styles.windowCounts}>
          <span className={styles.count}>
            <strong>{residual}</strong> {t('schemaEvolver.purgingPayloadsStillCarrying')}
          </span>
        </div>
        <CheckpointBar
          checkpoint={checkpoint}
          total={total}
          totalNote={t('schemaEvolver.purgingTotalNote', { total })}
        />
        <p className={styles.footnote}>
          {t('schemaEvolver.purgingFootnote1')}
          <code>describeModel()</code>
          {t('schemaEvolver.purgingFootnote2')}
          <strong>{t('schemaEvolver.purgingFootnoteStripped')}</strong>
          {t('schemaEvolver.purgingFootnote3')}
          <code>entry_data</code>
          {t('schemaEvolver.purgingFootnote4')}
        </p>
      </div>
    </div>
  );
}

/**
 * Two presses, in place.
 *
 * `window.confirm` is the obvious reach and the wrong one — it is a modal the
 * page cannot style, and the scenario picker already set the precedent for the
 * inline form. The label carries the consequence rather than a generic "are you
 * sure": for a model it says how many rows are about to be destroyed, because
 * that is the number nobody can get back.
 */
function DangerButton({
  label,
  confirm,
  disabled = false,
  onConfirm,
}: {
  label: string;
  confirm: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);

  return (
    <button
      type="button"
      className={`btn ${armed ? styles.armed : ''}`}
      disabled={disabled}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
      // Leaving the button re-safes it, so an armed control cannot sit waiting
      // for an accidental second click much later.
      onBlur={() => setArmed(false)}
    >
      {armed ? confirm : label}
    </button>
  );
}

/**
 * One text box and one button.
 *
 * Uncontrolled-per-mount rather than held on `SimWorld`: unlike the model draft
 * and the payload form, a half-typed new name is not something a later section
 * reads, nothing scripts it, and a scenario that wanted to would dispatch the
 * rename directly. The rule the roadmap sets is about state other sections need,
 * and this is not that.
 */
function RenameControl({
  label,
  current,
  hint,
  disabled = false,
  onSubmit,
}: {
  label: string;
  current: string;
  hint: string;
  disabled?: boolean;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState('');
  const t = useTranslations('playground');

  const submit = () => {
    const next = value.trim();
    if (next === '' || disabled) return;
    onSubmit(next);
    setValue('');
  };

  return (
    <div className={styles.control}>
      <label className={styles.controlLabel}>
        <span>{label}</span>
        <input
          type="text"
          value={value}
          placeholder={current}
          disabled={disabled}
          onChange={e => setValue(e.target.value)}
          // Enter is how anyone actually uses a single-field form, and without
          // this the box would need a deliberate reach for the button.
          onKeyDown={e => {
            if (e.key === 'Enter') submit();
          }}
        />
      </label>
      <button type="button" className="btn" onClick={submit} disabled={disabled} title={hint}>
        {t('schemaEvolver.renameButton')}
      </button>
      <span className={styles.hint}>{hint}</span>
    </div>
  );
}
