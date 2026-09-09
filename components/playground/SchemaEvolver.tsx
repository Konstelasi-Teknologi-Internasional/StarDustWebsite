'use client';

import { useState } from 'react';
import CodeBlock from '@/components/CodeBlock';
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

  return (
    <section className={styles.section} id="evolve" aria-labelledby="evolve-title" tabIndex={-1}>
      <p className="eyebrow">section f</p>
      <h2 id="evolve-title" className={styles.title}>
        Change the schema while it is live
      </h2>
      <p className="section-lede">
        Renaming a field is not a registry update — it is a rewrite of every row in
        the model, because the payload is keyed by name. Stop the Reconciler first
        and you can stand inside the migration and look around.
      </p>

      <div className={styles.beats}>
        <div className={styles.beat}>
          <h3 className={styles.beatTitle}>A window, not an instant</h3>
          <p>
            The registry flips the moment the call returns. Every payload written
            before that is still keyed by the old name, and stays that way until the
            backfill reaches it. The engine&rsquo;s job is not to hide that — it is to
            make every surface answer correctly <em>during</em> it.
          </p>
        </div>
        <div className={styles.beat}>
          <h3 className={styles.beatTitle}>Reads bridge it; filters do not</h3>
          <p>
            A read falls back from the new key to the old one, and a write is
            rewritten onto the new name before it is stored. A <em>filter</em> naming
            the old field is refused outright. That asymmetry is deliberate: a
            refused filter loses nothing and says so immediately, and a mis-keyed
            write loses data silently.
          </p>
        </div>
      </div>

      {world.models.length === 0 ? (
        <div className={`panel ${styles.empty}`}>
          <p>
            Nothing to change yet. Define a model in section A and write some rows in
            section C — a rename over an empty model completes on the Reconciler&rsquo;s
            first tick, which is correct and shows you nothing.
          </p>
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
          title="the registry's own lines"
          note="NDJSON · source=registry"
          empty="Nothing has changed the schema yet. Rename, retype or delete a field above and the transition appears here — the drain that carries it out is in the daemon room's stream."
        />
      </div>

      {world.lastLifecycle?.noop === true && OWNED_ACTIONS.has(world.lastLifecycle.action) && (
        <p className={styles.noop} role="status">
          That call returned <code>false</code> — nothing to do. The engine reports an
          unknown id, another tenant&rsquo;s, and a deletion already in flight the same
          way, which is what makes a repeated delete idempotent.
        </p>
      )}
    </section>
  );
}

function ModelPanel({ model }: { model: SimModel }) {
  const { world, dispatch } = usePlayground();
  const fields = fieldsOf(world, model.id);

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
            deleted_at set · purging
          </span>
        </div>

        <div className={styles.window}>
          <div className={styles.windowCounts}>
            <span className={styles.count}>
              <strong>{remaining}</strong> rows left to destroy
            </span>
            <span className={styles.count}>
              <strong>{fields.length}</strong> fields still visible to this panel
            </span>
          </div>
          <CheckpointBar
            checkpoint={purging}
            total={remaining}
            totalNote="of the rows still in entry_data — this partition shrinks as it is walked, unlike every other drain on this page, because the chunks delete what they claim"
          />
          <p className={styles.footnote}>
            <strong>The model has gone dark.</strong> A read returns nothing — not an
            error, nothing, exactly as for a model that never existed — and a write is{' '}
            <em>refused</em> rather than having its keys stripped. That is the deliberate
            inversion of the field rule: a deleted field leaves a valid residual entry
            and a deleted model leaves nothing to preserve. The final chunk drops the
            model row and cascades every field row away with it.
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
        <span className="tag tag-json">tenant {world.tenantId}</span>
      </div>

      <div className={styles.modelRename}>
        <RenameControl
          label="rename the model"
          current={model.name}
          hint="One UPDATE. Complete on return — no checkpoint, no window, and deliberately no schema-version bump."
          onSubmit={name => dispatch({ type: 'model/rename', modelId: model.id, name })}
        />
        <p className={styles.footnote}>
          Watch what does <strong>not</strong> happen: no row appears in{' '}
          <code>backfill_checkpoints</code> and <code>stardust_schema_version</code>{' '}
          does not move. Nothing cached holds a model name, so there is nothing to
          invalidate. The one real consequence is a footgun the engine keeps on
          purpose — <code>createModel()</code> is get-or-create keyed on the name, so
          a seed script still naming the old model makes a second one.
        </p>
        {/* Shown next to the field snippet further down on purpose: two calls
            with the same shape, one of which is a migration and one of which is
            a label change. */}
        <CodeBlock
          lang="php"
          title="what this button calls"
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
          label="delete this model"
          confirm={`destroy ${remaining} rows?`}
          onConfirm={() => dispatch({ type: 'model/delete', modelId: model.id })}
        />
        <p className={styles.footnote}>
          <strong>This is the only operation in the engine that physically removes{' '}
          <code>entry_data</code> rows, and there is no undelete.</strong> Severance is
          one transaction — the model and every field it owns are marked at once, which
          is what makes every existing field guard fire with no new conditions. The
          rows themselves go in chunks, along with their{' '}
          <code>stardust_sync_queue</code> entries, and the model row is dropped by the
          final chunk.
        </p>
        <CodeBlock
          lang="php"
          title="what this button calls"
          code={deleteModelSnippet(world.tenantId, model.id, model.name)}
        />
      </div>
    </div>
  );
}

function FieldRow({ field, model }: { field: SimField; model: SimModel }) {
  const { world, dispatch } = usePlayground();

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
            previous_name = {field.previousName}
          </span>
        )}
      </div>

      <RenameControl
        label="rename the field"
        current={field.name}
        disabled={inFlight || retyping !== undefined}
        hint={
          inFlight
            ? 'A rename is already draining for this field. The engine refuses an overlapping lifecycle rather than queueing it.'
            : retyping !== undefined
              ? 'A retype is in flight. Its backfill locates values by name, so a rename underneath it would write NULL slots silently.'
              : 'Returns as soon as the registry commits. The payload rewrite needs a running Reconciler.'
        }
        onSubmit={name => dispatch({ type: 'field/rename', fieldId: field.id, name })}
      />

      {inFlight && field.previousName !== null && (
        <div className={styles.window}>
          <div className={styles.windowCounts}>
            <span className={styles.count}>
              <strong>{migrated}</strong> rewritten to <code>{field.name}</code>
            </span>
            <span className={styles.count}>
              <strong>{stale}</strong> still stored as <code>{field.previousName}</code>
            </span>
          </div>
          <CheckpointBar
            checkpoint={renaming}
            total={entriesInModel}
            totalNote={`of ${entriesInModel} rows in entry_data for this model — backfill_checkpoints stores a cursor and a status and no total, so this is counted from the partition being drained`}
          />
          <p className={styles.footnote}>
            A read right now returns every one of those {entriesInModel} rows under{' '}
            <code>{field.name}</code>. The {stale} that are still stored as{' '}
            <code>{field.previousName}</code> resolve through the fallback — which is
            the only reason the window is survivable. A filter naming{' '}
            <code>{field.previousName}</code>, by contrast, is refused as an unknown
            field: as far as the registry is concerned it no longer exists.
          </p>
        </div>
      )}

      <RetypeControl field={field} disabled={inFlight || retyping !== undefined} />

      <div className={styles.danger}>
        <DangerButton
          label={`delete ${field.name}`}
          confirm="delete permanently?"
          disabled={inFlight || retyping !== undefined}
          onConfirm={() => dispatch({ type: 'field/delete', fieldId: field.id })}
        />
        <p className={styles.footnote}>
          Severs from every surface in one commit and purges the payloads
          asynchronously. Its name is <strong>not reusable</strong> until the purge
          lands — <code>ux_fields_model_name</code> is unconditional, so the dying row
          still holds it.
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
        title={inFlight ? 'in flight' : 'what this row can call'}
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

  return (
    <div className={styles.retype}>
      <span className={styles.controlLabelInline}>retype to</span>
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
                  ? 'Already this type.'
                  : rejected
                    ? `${field.declaredType} → ${type} is categorically refused: there is no defensible epoch convention to pick between seconds, milliseconds and a packed date.`
                    : `retypeField() — overwrites declared_type now and rewrites every value through the ${field.declaredType} → ${type} cell of the matrix.`
              }
            >
              {type}
            </button>
          );
        })}
      </div>
      <span className={styles.hint}>
        The old slot is tombstoned and a replacement is reserved from the{' '}
        <strong>new</strong> family — so a retype across families needs the Watcher to
        provision a page it has no indexed column on yet. Values that will not convert
        are written <code>NULL</code> with an audited reason rather than rounded or
        truncated: <code>2.5</code> becoming an <code>int</code> is a{' '}
        <code>coercion_null</code>, not a <code>2</code>.
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
          deleted_at set · purging
        </span>
      </div>

      <div className={styles.window}>
        <div className={styles.windowCounts}>
          <span className={styles.count}>
            <strong>{residual}</strong> payloads still carrying the key
          </span>
        </div>
        <CheckpointBar
          checkpoint={checkpoint}
          total={total}
          totalNote={`of ${total} rows in entry_data for this model`}
        />
        <p className={styles.footnote}>
          It is already gone from reads, filters, exports and{' '}
          <code>describeModel()</code> — and a write still sending the key has it
          silently <strong>stripped</strong> rather than refused, which is what bounds
          the purge. An unregistered key would otherwise be preserved verbatim, so a
          client that had not redeployed would keep writing the field back into rows
          the cursor had already passed. Look at <code>entry_data</code> in the table
          inspector: the values are visibly still there.
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
        rename
      </button>
      <span className={styles.hint}>{hint}</span>
    </div>
  );
}
