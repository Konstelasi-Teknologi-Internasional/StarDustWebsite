'use client';

import { useTranslations } from '@/lib/i18n';
import type { FilterNode, LeafNode, LeafOperator } from '@/lib/sim/filter/ast';
import { isLeaf, isRangeOperator, isSetOperator, isPresenceOperator } from '@/lib/sim/filter/ast';
import { formatBuilderValue, operatorsFor, pathKey, type NodePath } from '@/lib/sim/query';
import type { SimField } from '@/lib/sim/types';
import { fieldIndexState } from '@/lib/sim/world';
import { usePlayground } from './PlaygroundContext';
import styles from './QueryBuilder.module.css';

/**
 * The filter tree, as rows you can edit.
 *
 * Every gesture here dispatches into the reducer and the tree it edits **is**
 * the wire AST — there is no builder-flavoured copy with a converter in the
 * middle, which is what lets the JSON pane beside it claim to be the same
 * object rather than a rendering of one.
 *
 * **No drag-and-drop, deliberately.** Section A drags because a field list has
 * an order worth expressing with your hands; a filter tree has structure
 * instead, and its edits are "group these two with OR" and "negate this" —
 * operations a drag would have to encode as a gesture and then explain. Buttons
 * and selects say what they do, work with a keyboard for free, and avoid the
 * two drag traps section A had to solve.
 *
 * Nodes are addressed by path rather than by an id, because an AST node has no
 * identity in the wire format and inventing one would put a key in the tree
 * that the format does not have.
 */
export default function FilterTree({ node, path }: { node: FilterNode; path: NodePath }) {
  if (isLeaf(node)) return <LeafRow leaf={node} path={path} />;
  if (node.op === 'not') return <NotRow node={node} path={path} />;
  return <GroupRow node={node} path={path} />;
}

function GroupRow({
  node,
  path,
}: {
  node: Extract<FilterNode, { op: 'and' | 'or' }>;
  path: NodePath;
}) {
  const { dispatch } = usePlayground();
  const t = useTranslations('playground');

  return (
    <div className={styles.group}>
      <div className={styles.groupHead}>
        <button
          type="button"
          className={`${styles.op} ${node.op === 'or' ? styles.opOr : ''}`}
          onClick={() => dispatch({ type: 'query/toggleGroup', path })}
          title={
            node.op === 'and'
              ? t('filterTree.switchToOrTitle')
              : t('filterTree.switchToAndTitle')
          }
        >
          {node.op}
        </button>
        <span className={styles.groupNote}>
          {node.op === 'and' ? t('filterTree.andNote') : t('filterTree.orNote')}
        </span>
        <NodeActions path={path} />
      </div>

      <div className={styles.children}>
        {node.args.map((child, index) => (
          <FilterTree key={pathKey([...path, index])} node={child} path={[...path, index]} />
        ))}
      </div>
    </div>
  );
}

function NotRow({ node, path }: { node: Extract<FilterNode, { op: 'not' }>; path: NodePath }) {
  const t = useTranslations('playground');

  return (
    <div className={`${styles.group} ${styles.groupNot}`}>
      <div className={styles.groupHead}>
        <span className={`${styles.op} ${styles.opNot}`}>not</span>
        <span className={styles.groupNote}>{t('filterTree.notNote')}</span>
        <NodeActions path={path} />
      </div>
      <div className={styles.children}>
        <FilterTree node={node.arg} path={[...path, 0]} />
      </div>
    </div>
  );
}

function LeafRow({ leaf, path }: { leaf: LeafNode; path: NodePath }) {
  const { world, dispatch } = usePlayground();
  const t = useTranslations('playground');
  const modelId = world.queryDraft.modelId;

  // Derived from the registry on every render, never snapshotted into the
  // draft. A field added in section A after this condition was built has to
  // appear in the dropdown without anything here remembering to resynchronise.
  const fields = world.fields.filter(f => f.modelId === modelId && f.deletedAt === null);
  const field = fields.find(f => f.name === leaf.field.name);
  const declaredType = field?.declaredType ?? 'string';

  return (
    <div className={styles.leaf}>
      <select
        className={styles.select}
        value={leaf.field.name}
        aria-label={t('filterTree.fieldAriaLabel')}
        onChange={e => dispatch({ type: 'query/setField', path, fieldName: e.target.value })}
      >
        {/* A leaf naming a field that is no longer registered keeps its own
            option, or selecting it would silently rewrite the visitor's filter
            into a different one — and `field_unknown` is a rejection worth
            reaching. */}
        {field === undefined && <option value={leaf.field.name}>{leaf.field.name}</option>}
        {fields.map(f => (
          <option key={f.id} value={f.name}>
            {f.name}
          </option>
        ))}
      </select>

      <select
        className={styles.select}
        value={leaf.op}
        aria-label={t('filterTree.operatorAriaLabel')}
        onChange={e =>
          dispatch({ type: 'query/setOperator', path, op: e.target.value as LeafOperator })
        }
      >
        {operatorsFor(declaredType).map(op => (
          <option key={op} value={op}>
            {op}
          </option>
        ))}
      </select>

      <ValueInput leaf={leaf} path={path} />

      {field !== undefined && <IndexChip field={field} />}

      <NodeActions path={path} />
    </div>
  );
}

function ValueInput({ leaf, path }: { leaf: LeafNode; path: NodePath }) {
  const { dispatch } = usePlayground();
  const t = useTranslations('playground');

  if (isPresenceOperator(leaf.op)) {
    return (
      <span className={styles.noValue}>
        {t('filterTree.noValue1')}
        <code>{leaf.op}</code>
        {t('filterTree.noValue2')}
        <code>value_unexpected</code>
      </span>
    );
  }

  if (isRangeOperator(leaf.op)) {
    const pair = Array.isArray(leaf.value) ? leaf.value : [];
    return (
      <span className={styles.pair}>
        <input
          className={styles.input}
          aria-label={t('filterTree.lowerBoundAriaLabel')}
          value={String(pair[0] ?? '')}
          onChange={e => dispatch({ type: 'query/setValue', path, text: e.target.value, index: 0 })}
        />
        <span className={styles.and}>{t('filterTree.and')}</span>
        <input
          className={styles.input}
          aria-label={t('filterTree.upperBoundAriaLabel')}
          value={String(pair[1] ?? '')}
          onChange={e => dispatch({ type: 'query/setValue', path, text: e.target.value, index: 1 })}
        />
      </span>
    );
  }

  return (
    <input
      className={styles.input}
      aria-label={t('filterTree.valueAriaLabel')}
      placeholder={
        isSetOperator(leaf.op) ? t('filterTree.setPlaceholder') : t('filterTree.valuePlaceholder')
      }
      value={formatBuilderValue(leaf.value)}
      onChange={e => dispatch({ type: 'query/setValue', path, text: e.target.value })}
    />
  );
}

/**
 * Whether a filter on this field would work right now.
 *
 * Straight from `fieldIndexState()` — the same function section A's "not
 * indexed yet" marker and section D's readout ask, so the three cannot drift
 * apart. Showing it beside the condition is what turns a rejection from a
 * surprise into something the visitor could see coming.
 */
function IndexChip({ field }: { field: SimField }) {
  const { world } = usePlayground();
  const state = fieldIndexState(world, field.id);
  const t = useTranslations('playground');

  if (state === 'live') {
    return (
      <span className={`tag tag-indexed ${styles.chip}`}>
        <span className="dot" />
        {t('filterTree.indexedTag')}
      </span>
    );
  }
  return (
    <span className={`tag ${state === 'building' ? 'tag-pending' : 'tag-error'} ${styles.chip}`}>
      <span className="dot" />
      {t(state === 'building' ? 'filterTree.backfillingTag' : 'filterTree.noSlotTag')}
    </span>
  );
}

function NodeActions({ path }: { path: NodePath }) {
  const { dispatch } = usePlayground();
  const t = useTranslations('playground');

  return (
    <span className={styles.actions}>
      <button
        type="button"
        className={styles.iconBtn}
        title={t('filterTree.wrapOrTitle')}
        onClick={() => dispatch({ type: 'query/wrap', path, kind: 'or' })}
      >
        or
      </button>
      <button
        type="button"
        className={styles.iconBtn}
        title={t('filterTree.negateTitle')}
        onClick={() => dispatch({ type: 'query/wrap', path, kind: 'not' })}
      >
        not
      </button>
      <button
        type="button"
        className={styles.iconBtn}
        title={t('filterTree.removeTitle')}
        aria-label={t('filterTree.removeAriaLabel')}
        onClick={() => dispatch({ type: 'query/removeNode', path })}
      >
        ×
      </button>
    </span>
  );
}
