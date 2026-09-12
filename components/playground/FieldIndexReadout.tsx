'use client';

import { useTranslations } from '@/lib/i18n';
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
  const t = useTranslations('playground');

  if (world.models.length === 0) {
    return (
      <div className={`panel ${styles.empty}`}>
        <p>{t('fieldIndexReadout.empty')}</p>
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
            <span className="tag tag-json">{t('fieldIndexReadout.headTag')}</span>
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

      {/* Scoped to the two lifecycles *this* section drives.
          `lastLifecycle` is one slot on the world and six actions write it, so
          without the filter a rename refused in section F would print here too
          — four screens from the button that caused it, with no context and no
          way to tell it apart from something this panel did. Section F carries
          the same filter for the other four. */}
      {/* Simulates the message a real RetypeInProgressException would carry —
          untranslated in both locales, same fidelity rule as `draft.error`. */}
      {world.lastLifecycle?.error != null &&
        (world.lastLifecycle.action === 'promote' ||
          world.lastLifecycle.action === 'demote') && (
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
  const t = useTranslations('playground');

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
              ? t('fieldIndexReadout.checkpointInFlightTitle')
              : field.isFilterable
                ? t('fieldIndexReadout.demoteTitle')
                : t('fieldIndexReadout.promoteTitle')
          }
        >
          {field.isFilterable ? t('fieldIndexReadout.demote') : t('fieldIndexReadout.promote')}
        </button>
      </div>

      <div className={styles.flags}>
        <Flag
          label="isFilterable"
          value={field.isFilterable}
          tone={field.isFilterable ? 'accent' : 'json'}
          note={t('fieldIndexReadout.filterableNote')}
        />
        <Flag
          label="isIndexed"
          value={indexed}
          tone={indexed ? 'indexed' : 'pending'}
          note={t(indexed ? 'fieldIndexReadout.indexedNoteTrue' : 'fieldIndexReadout.indexedNoteFalse')}
        />
      </div>

      <div className={styles.slotRow}>
        <span className={styles.slotLabel}>{t('fieldIndexReadout.slotLabel')}</span>
        {slot === undefined ? (
          <span className="tag tag-error">
            <span className="dot" />
            {t('fieldIndexReadout.noneReserved')}
          </span>
        ) : (
          <span className={`tag ${state === 'live' ? 'tag-indexed' : 'tag-pending'}`}>
            <span className="dot" />
            {slot.slotColumn} · {slot.status}
          </span>
        )}
        <span className={styles.verdict}>
          {t(
            state === 'live'
              ? 'fieldIndexReadout.verdictLive'
              : state === 'building'
                ? 'fieldIndexReadout.verdictBuilding'
                : field.isFilterable
                  ? 'fieldIndexReadout.verdictNoSlot'
                  : 'fieldIndexReadout.verdictJsonOnly',
          )}
        </span>
      </div>

      {checkpoint !== undefined && (
        <CheckpointBar
          checkpoint={checkpoint}
          total={entriesInModel}
          totalNote={t('fieldIndexReadout.checkpointTotalNote', { total: entriesInModel })}
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
