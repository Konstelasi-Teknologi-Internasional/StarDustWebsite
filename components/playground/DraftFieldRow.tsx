'use client';

import type { PointerEvent as ReactPointerEvent } from 'react';
import type { DraftField } from '@/lib/sim/draft';
import { DECLARED_TYPES } from '@/lib/sim/registry';
import type { DeclaredType } from '@/lib/sim/types';
import styles from './ModelBuilder.module.css';

type Props = {
  field: DraftField;
  index: number;
  count: number;
  dragging: boolean;
  /**
   * This field is already a row in `stardust_fields`.
   *
   * `createModel()` is get-or-create: it can add a field to an existing model
   * and it can do nothing else. It does not rename, retype, promote, demote
   * or remove — those are five separate entry points, each with its own
   * migration window, and none of them is reachable from here. So a committed
   * field is shown and not offered for editing, because offering an edit that
   * silently does nothing is worse than not offering it.
   *
   * The rename case is the one that made this non-negotiable: typing a new
   * name over a committed field does not rename anything, it *inserts a
   * second field* under the new name and leaves the original in place. That
   * is what the engine would really do, and it is the last thing a visitor
   * would expect to have caused.
   */
  locked: boolean;
  onPatch: (patch: Partial<Omit<DraftField, 'key'>>) => void;
  onRemove: () => void;
  onMove: (to: number) => void;
  /** Wired to the drag hook. The grip is the only draggable part of the row. */
  onGripDown: (e: ReactPointerEvent<HTMLElement>) => void;
  gripHandlers: {
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  };
};

/**
 * One field in the model being defined.
 *
 * Every control here is a real control — a text input, a `<select>`, and
 * three buttons. Dragging the grip reorders the row, but so do the move
 * buttons, and the type is a dropdown before it is anything draggable. The
 * drag is the affordance on top; it is never the only way through.
 *
 * The layout and the toggle are lifted from `SlotMirror`, deliberately as a
 * copy rather than a shared import: the landing page is shipped and working,
 * and coupling four proven demos to a growing simulator would trade a stable
 * asset for a convenience.
 */
export default function DraftFieldRow({
  field,
  index,
  count,
  dragging,
  locked,
  onPatch,
  onRemove,
  onMove,
  onGripDown,
  gripHandlers,
}: Props) {
  return (
    <div
      className={`${styles.row} ${dragging ? styles.rowDragging : ''} ${
        locked ? styles.rowLocked : ''
      }`}
    >
      {locked ? (
        <span className={styles.lock} aria-hidden="true">
          ▣
        </span>
      ) : (
        <span
          className={styles.grip}
          onPointerDown={onGripDown}
          {...gripHandlers}
          // The grip is decorative for assistive tech: it duplicates the move
          // buttons beside it, and announcing a drag handle that a keyboard
          // cannot operate is worse than announcing nothing.
          aria-hidden="true"
        >
          ⠿
        </span>
      )}

      <input
        className={styles.name}
        value={field.name}
        spellCheck={false}
        readOnly={locked}
        aria-label={`name of field ${index + 1}`}
        onChange={e => onPatch({ name: e.target.value })}
      />

      <select
        className={styles.type}
        value={field.declaredType}
        disabled={locked}
        aria-label={`declared type of ${field.name}`}
        onChange={e => onPatch({ declaredType: e.target.value as DeclaredType })}
      >
        {DECLARED_TYPES.map(t => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>

      <button
        type="button"
        role="switch"
        aria-checked={field.isFilterable}
        disabled={locked}
        className={`${styles.toggle} ${field.isFilterable ? styles.toggleOn : ''}`}
        onClick={() => onPatch({ isFilterable: !field.isFilterable })}
      >
        <span className={styles.knob} />
        {field.isFilterable ? 'filterable' : 'JSON only'}
      </button>

      <span className={styles.rowActions}>
        {locked && <span className="tag tag-json">in the registry</span>}
        <button
          type="button"
          className={styles.icon}
          disabled={locked || index === 0}
          aria-label={`move ${field.name} up`}
          onClick={() => onMove(index - 1)}
        >
          ↑
        </button>
        <button
          type="button"
          className={styles.icon}
          disabled={locked || index === count - 1}
          aria-label={`move ${field.name} down`}
          onClick={() => onMove(index + 1)}
        >
          ↓
        </button>
        <button
          type="button"
          className={styles.icon}
          disabled={locked}
          aria-label={`remove ${field.name}`}
          onClick={onRemove}
        >
          ✕
        </button>
      </span>
    </div>
  );
}
