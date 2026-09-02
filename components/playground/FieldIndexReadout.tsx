'use client';

import type { SimField } from '@/lib/sim/types';
import { runningCheckpointForField } from '@/lib/sim/retype';
import { fieldIndexState, fieldsOf, liveSlotForField } from '@/lib/sim/world';
import CheckpointBar from './CheckpointBar';
import { usePlayground } from './PlaygroundContext';
import styles from './FieldIndexReadout.module.css';

/**
 * `describeModel()`, and the two flags whose divergence is the whole point.
 *
 * `isFilterable` is what the registry says you asked for. `isIndexed` is
 * whether a filter would actually work this second. They agree most of the
 * time, and every interesting thing on this page happens in the gap:
 *
 *   - **No slot at all** — the call returned, the flag is set, and nothing has
 *     been indexed. This is the state people file bugs about.
 *   - **`backfilling`** — a slot exists and is being filled. Still rejected,
 *     because a half-built index must never answer as though it were complete.
 *     A filter here is refused *loudly*, so a partial index can never
 *     masquerade as "no matches".
 *   - **`assigned` or `ready`** — a filter reads a real index.
 *
 * The rejection is named but not run: building a filter is the next section's
 * job, and the answer to "would this work right now" comes from
 * `fieldIndexState()`, which is the one shared definition every section uses.
 */
export default function FieldIndexReadout() {
  const { world, dispatch } = usePlayground();

  if (world.models.length === 0) {
    return (
      <div className={`panel ${styles.empty}`}>
        <p>
          Define a model in section A first. This panel reads the registry, and
          there is nothing in it yet.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.stack}>
      {world.models.map(model => (
        <div key={model.id} className={`panel ${styles.panel}`}>
          <div className="panel-head">
            <span>
              describeModel({world.tenantId}, {model.id}) → {model.name}
            </span>
            <span className="tag tag-json">registry intent vs. live index</span>
          </div>

          <div className={styles.rows}>
            {fieldsOf(world, model.id).map(field => (
              <FieldRow
                key={field.id}
                field={field}
                onPromote={() => dispatch({ type: 'field/promote', fieldId: field.id })}
                onDemote={() => dispatch({ type: 'field/demote', fieldId: field.id })}
              />
            ))}
          </div>
        </div>
      ))}

      {world.lastLifecycle?.error != null && (
        <p className={styles.error} role="status">
          {world.lastLifecycle.error}
        </p>
      )}
    </div>
  );
}

function FieldRow({
  field,
  onPromote,
  onDemote,
}: {
  field: SimField;
  onPromote: () => void;
  onDemote: () => void;
}) {
  const { world } = usePlayground();

  const state = fieldIndexState(world, field.id);
  const slot = liveSlotForField(world, field.id);
  const checkpoint = runningCheckpointForField(world, field.id);

  const indexed = state === 'live';
  const entriesInModel = world.entries.filter(
    e => e.modelId === field.modelId && e.tenantId === world.tenantId,
  ).length;

  return (
    <div className={styles.row}>
      <div className={styles.head}>
        <span className={styles.field}>
          {field.name}
          <em>{field.declaredType}</em>
        </span>

        <button
          type="button"
          className="btn"
          onClick={field.isFilterable ? onDemote : onPromote}
          disabled={checkpoint !== undefined}
          title={
            checkpoint !== undefined
              ? 'A retype is already in flight for this field. The engine refuses an overlapping lifecycle rather than queueing it.'
              : field.isFilterable
                ? 'demoteFieldFromFilterable() — registry-only, and the slot is tombstoned for the Liberator'
                : 'promoteFieldToFilterable() — returns immediately; a daemon finishes it'
          }
        >
          {field.isFilterable ? 'demote' : 'promote'}
        </button>
      </div>

      <div className={styles.flags}>
        <Flag
          label="isFilterable"
          value={field.isFilterable}
          tone={field.isFilterable ? 'accent' : 'json'}
          note="registry intent — set the moment the call returned"
        />
        <Flag
          label="isIndexed"
          value={indexed}
          tone={indexed ? 'indexed' : 'pending'}
          note={
            indexed
              ? 'a filter reads a real index right now'
              : 'no live slot a filter could use yet'
          }
        />
      </div>

      <div className={styles.slotRow}>
        <span className={styles.slotLabel}>slot</span>
        {slot === undefined ? (
          <span className="tag tag-error">
            <span className="dot" />
            none reserved
          </span>
        ) : (
          <span className={`tag ${state === 'live' ? 'tag-indexed' : 'tag-pending'}`}>
            <span className="dot" />
            {slot.slotColumn} · {slot.status}
          </span>
        )}
        <span className={styles.verdict}>
          {state === 'live'
            ? 'a filter on this field is compiled against the slot column'
            : state === 'building'
              ? 'a filter is rejected — FieldNotFilterableException, because the index is only half built'
              : field.isFilterable
                ? 'a filter is rejected — FieldNotFilterableException, no slot exists to read'
                : 'JSON-only by design. A filter is rejected until you promote it.'}
        </span>
      </div>

      {checkpoint !== undefined && (
        <CheckpointBar
          checkpoint={checkpoint}
          total={entriesInModel}
          totalNote={`of ${entriesInModel} rows in entry_data for this model — the table stores no total, so this is counted from the partition being drained`}
        />
      )}
    </div>
  );
}

function Flag({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: boolean;
  tone: 'accent' | 'indexed' | 'pending' | 'json';
  note: string;
}) {
  return (
    <div className={styles.flag}>
      <span className={styles.flagLabel}>{label}</span>
      <span className={`tag tag-${tone}`}>
        <span className="dot" />
        {String(value)}
      </span>
      <span className={styles.flagNote}>{note}</span>
    </div>
  );
}
