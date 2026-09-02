'use client';

import type { PayloadRow } from '@/lib/sim/payload';
import { coerceForSlot } from '@/lib/sim/write';
import type { FieldIndexState } from '@/lib/sim/world';
import styles from './EntryWriter.module.css';

type Props = {
  field: PayloadRow;
  /**
   * Whether a filter on this field would work *right now*, straight from the
   * core. `'none'` for the whole of this stage, because nothing has reserved a
   * slot yet — and `null` for an unknown key, which has no registry row to ask
   * about.
   */
  indexState: FieldIndexState | null;
  onValue: (value: string) => void;
  onRename: (name: string) => void;
  onRemove: () => void;
};

/**
 * One key of the payload being composed.
 *
 * **Every input is a plain text box, whatever the field's declared type.**
 * Filtering an `int` input down to digits would put a coercion rule inside a
 * component, and worse, it would make `UncoercibleSlotValueException`
 * unreachable — typing `3.5` into an `int` field and watching the engine
 * refuse it with its own message is a thing this section is for.
 *
 * The chip beside the input is that refusal, shown early. It calls
 * `coerceForSlot()` — the same function the write path calls, not a
 * reimplementation of it — so what it predicts and what happens cannot drift.
 * It is labelled as a preview because at this stage it *is* one: no slot
 * exists, so nothing is coerced yet and the value only lands in the JSON.
 */
export default function PayloadFieldRow({
  field,
  indexState,
  onValue,
  onRename,
  onRemove,
}: Props) {
  const unknown = field.declaredType === null;

  const coercion =
    field.declaredType === null || field.value === ''
      ? null
      : coerceForSlot(field.value, field.declaredType, field.name);

  return (
    <div className={`${styles.payloadRow} ${unknown ? styles.payloadRowUnknown : ''}`}>
      {unknown ? (
        <input
          className={styles.payloadKey}
          value={field.name}
          spellCheck={false}
          aria-label="unknown payload key"
          onChange={e => onRename(e.target.value)}
        />
      ) : (
        <span className={styles.payloadKey} title="a field of this model">
          {field.name}
        </span>
      )}

      <span className={styles.payloadMeta}>
        {unknown ? (
          <span className="tag tag-json">not in the registry</span>
        ) : (
          <>
            <span className="tag tag-json">{field.declaredType}</span>
            {indexState === 'none' && (
              <span className="tag tag-pending" title="a filter on this would be rejected">
                <span className="dot" />
                no slot
              </span>
            )}
            {indexState === 'building' && (
              <span className="tag tag-pending">
                <span className="dot" />
                backfilling
              </span>
            )}
            {indexState === 'live' && (
              <span className="tag tag-indexed">
                <span className="dot" />
                indexed
              </span>
            )}
          </>
        )}
      </span>

      <input
        className={styles.payloadValue}
        value={field.value}
        spellCheck={false}
        placeholder="leave empty to omit the key"
        aria-label={`value for ${field.name}`}
        onChange={e => onValue(e.target.value)}
      />

      <span className={styles.payloadNote}>
        {coercion === null ? null : coercion.ok ? (
          <span className={styles.coerceOk}>
            would coerce to <code>{JSON.stringify(coercion.value)}</code>
          </span>
        ) : (
          <span className={styles.coerceBad}>{coercion.error}</span>
        )}
      </span>

      <button
        type="button"
        className={styles.icon}
        // A registered row is the model, and removing it from the form would
        // suggest it can be removed from the model. That is `deleteField()`,
        // a migration over live data, and it is not on this screen.
        disabled={!unknown}
        aria-label={unknown ? `remove key ${field.name}` : undefined}
        title={unknown ? 'remove this key' : 'a field of this model — edit it in section A'}
        onClick={onRemove}
      >
        ✕
      </button>
    </div>
  );
}
