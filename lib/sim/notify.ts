/**
 * Milestones — the page's own voice, derived from the engine's.
 *
 * The playground is five sections tall and every section acts on the others.
 * Pressing **run** on the sticky bar changes a slot four screens down;
 * promoting a field turns section E's rejection into rows without section E
 * being on screen. A visitor who presses a button and sees nothing move
 * concludes the button is broken, which is the opposite of the lesson.
 *
 * The fix is not to float {@link ../../components/playground/EventLog}. That
 * panel is the *engine's* voice: `events.ts` mirrors ADR 0020 as a closed
 * union, and the log renders `seq` and `tick` outside the braces precisely so
 * that no invented key appears in a panel whose whole claim is that these are
 * the engine's own lines. It is also the wrong grain: a visitor wants to know
 * that `city` is queryable now, not that a `promote_to_ready` line carrying six
 * fields was appended by the Reconciler.
 *
 * So this is a second register: page copy about *consequence*, keyed to the
 * section a visitor would have to scroll to in order to see it. Four rules,
 * and each is load-bearing:
 *
 * 1. **Milestones, not lines.** {@link MILESTONES} maps a small allowlisted
 *    subset of event names. Everything else narrates nothing, which is the
 *    right default for fifty of the fifty-eight.
 * 2. **This module lives in `lib/sim/`**, because *which* transitions matter
 *    is a claim about the engine and fidelity rule 1 says no component gets to
 *    encode one. It also keeps the module React-free and relatively imported,
 *    which is what lets `tsconfig.scripts.json` emit it to CJS so
 *    `verify-scenarios.ts` can assert on what a scenario narrates.
 * 3. **It reads `fields`, never `detail`.** The rendered `key=value` text is
 *    another module's output format, and a value may contain a space, so
 *    parsing it back would be lossy in a way nothing would catch.
 * 4. **The feed is a projection of the stream the log shows**, so it cannot
 *    claim something the engine did not emit. What it may add is *wording*.
 *
 * The `world` handed to a spec is the state **after** the event, which is what
 * makes "`city` is indexed" a fact to look up rather than a claim to trust.
 */

import enNotify from '../../messages/en/notify.json';
import { createTranslator, type MessageNode, type Translate } from '../i18n/resolve';
import type { EventFields, EventName, SimEvent } from './events';
import { fieldIndexState, type SimWorld } from './world';

/**
 * The English translator, for the two callers with no locale to ask: a
 * plain Node process (`verify-narration.ts` and friends, which only check
 * that a milestone says *something*) and any caller that does not pass one.
 * `useNarration` passes the real one, bound to whichever locale is live.
 */
const defaultTranslate: Translate = createTranslator(enNotify as MessageNode);

/* ------------------------------------------------------------------ *
 * The six section anchors
 * ------------------------------------------------------------------ */

/**
 * The `id` of every section a milestone can point at.
 *
 * Closed, and matching the `id=` on the six `<section>` elements exactly —
 * these are already a public contract, since `ScenarioStrip` jump-links to
 * them and every section module carries a `scroll-margin-top` so the landing
 * clears the fixed nav and the sticky bar.
 */
export const FEED_SECTIONS = [
  'define',
  'tables',
  'write',
  'daemons',
  'query',
  'evolve',
] as const;

export type FeedSection = (typeof FEED_SECTIONS)[number];

/* ------------------------------------------------------------------ *
 * The vocabulary
 * ------------------------------------------------------------------ */

/**
 * One kind per mapped event. Closed for the same reason `EVENT_NAMES` is: a
 * scenario declares the milestones its payoff must produce, and a typo in one
 * of those should be a `npm run typecheck` failure rather than an assertion
 * that silently never matches.
 *
 * Deliberately kebab-case, where the engine's names are snake_case. These are
 * not event names and must never be mistaken for them.
 */
export const MILESTONE_KINDS = [
  'page-provisioned',
  'slot-reserved',
  'field-indexed',
  'lifecycle-started',
  'write-outran-index',
  'row-quarantined',
  'filter-refused',
  'column-reclaimed',
  'rename-in-flight',
  'rename-landed',
  'field-severed',
  'field-purged',
  'model-severed',
  'model-purged',
] as const;

export type MilestoneKind = (typeof MILESTONE_KINDS)[number];

/**
 * Maps to the palette's three semantic colours, not to a log level. A
 * `dlq_inserted` line is `warn` to an operator and is `warn` here too, but the
 * mapping is a coincidence rather than a rule — `retype_started` is `info` on
 * the wire and neutral here because a promotion is neither good news nor bad
 * until it lands.
 */
export type MilestoneTone = 'neutral' | 'good' | 'warn';

export interface Milestone {
  /** The line this came from. Monotonic, so it doubles as identity. */
  seq: number;
  kind: MilestoneKind;
  section: FeedSection;
  /** One short clause. Sentence case — never `key=value`. */
  headline: string;
  /** One sentence saying why it matters. */
  detail: string;
  tone: MilestoneTone;
}

/** A milestone that stands in for `count` identical ones. */
export interface CoalescedMilestone extends Milestone {
  count: number;
}

/* ------------------------------------------------------------------ *
 * Reading a payload
 * ------------------------------------------------------------------ */

/**
 * The readers take `EventFields | undefined` on purpose.
 *
 * `SimEvent.fields` is required going forward, but a line restored from a
 * snapshot written before that member existed genuinely has none — that is the
 * compatibility this design buys in exchange for keeping `detail` stored, and
 * it is what let the change land without a `SIM_SCHEMA_VERSION` bump. Such a
 * line reads every key as `undefined`, so its spec declines and it narrates
 * nothing. Correct: narration is about what just happened, not about history
 * the visitor has already scrolled past.
 */
/**
 * `4 string · 4 int · 4 numeric · 4 datetime`, from the column list.
 *
 * Counted rather than assumed: the headroom is a floor, so a family with more
 * waiters than headroom gets more columns, and a card claiming four of each
 * would be quietly wrong exactly when the page is interesting.
 */
function countByFamily(columns: string[]): string {
  const labels: Record<string, string> = {
    str: 'string',
    int: 'int',
    num: 'numeric',
    dt: 'datetime',
  };
  const counts = new Map<string, number>();

  for (const column of columns) {
    const family = column.split('_')[1] ?? '';
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([family, n]) => `${n} ${labels[family] ?? family}`)
    .join(' · ');
}

function str(fields: EventFields | undefined, key: string): string | undefined {
  const value = fields?.[key];
  return typeof value === 'string' ? value : undefined;
}

function num(fields: EventFields | undefined, key: string): number | undefined {
  const value = fields?.[key];
  return typeof value === 'number' ? value : undefined;
}

function bool(fields: EventFields | undefined, key: string): boolean | undefined {
  const value = fields?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** A field's name, or `undefined` when the row is gone or was never resolved. */
function fieldName(world: SimWorld, fieldId: number | undefined): string | undefined {
  if (fieldId === undefined) return undefined;
  return world.fields.find(f => f.id === fieldId)?.name;
}

/* ------------------------------------------------------------------ *
 * The map
 * ------------------------------------------------------------------ */

/**
 * What a spec produces, or `null` to decline this particular line.
 *
 * A key into `notify.json` plus the params to interpolate into it, never a
 * rendered string — the actual rendering happens in {@link toMilestone}, the
 * one place that holds a `Translate`. A spec that resolves its own sub-phrase
 * (`preFlightRejected`'s `reason`) takes `translate` for exactly that reason.
 */
type Say = {
  headlineKey: string;
  headlineParams?: Record<string, string | number>;
  detailKey: string;
  detailParams?: Record<string, string | number>;
} | null;

interface MilestoneSpec {
  kind: MilestoneKind;
  section: FeedSection;
  tone: MilestoneTone;
  say(fields: EventFields | undefined, world: SimWorld, translate: Translate): Say;
}

/**
 * The allowlist. **Adding narration is adding a key here** — no component, no
 * hook and no renderer is touched, and an event absent from this table simply
 * does not narrate.
 *
 * Two names are deliberately **not** mapped, for two different reasons.
 *
 * `provision_complete` and `page_provisioned` describe one provisioning from
 * two sides, and the second is the one carrying `page_id` and
 * `filterable_slots` — mapping both would put two cards on screen for one thing
 * that happened once.
 *
 * `model_renamed` has no consequence at a distance, which is the whole test
 * this feed applies. A model name is load-bearing nowhere: no snapshot holds
 * one, no filter resolves through one, and the rename is complete before the
 * call returns — so there is no other section for a card to send anyone to. It
 * is a `registry` line in the log panel and nothing more. Compare
 * `rename_started` two entries down, whose entire point is that something four
 * screens away is now in a state the visitor cannot see from here.
 */
const MILESTONES: Partial<Record<EventName, MilestoneSpec>> = {
  page_provisioned: {
    kind: 'page-provisioned',
    section: 'tables',
    tone: 'neutral',
    say(fields) {
      const pageId = num(fields, 'page_id');
      const table = str(fields, 'table_name');
      if (pageId === undefined || table === undefined) return null;

      // Since ADR 0043 the page's columns *are* its indexed columns, so there
      // is no second number to report and no `none` case: a plan naming no
      // column is a page the planner declines to provision at all.
      //
      // Summarised by family rather than enumerated. Sixteen column names is
      // the ordinary case now, and a card that lists them all is a card nobody
      // reads — while the shape, four of each, is the whole point.
      const indexed = str(fields, 'filterable_slots') ?? '';
      const columns = indexed === '' ? [] : indexed.split(',');
      const shape = countByFamily(columns);
      return {
        headlineKey: 'pageProvisioned.headline',
        headlineParams: { pageId },
        detailKey: 'pageProvisioned.detail',
        detailParams: { tableName: table, columnCount: columns.length, shape },
      };
    },
  },

  slot_reserved: {
    kind: 'slot-reserved',
    section: 'tables',
    tone: 'neutral',
    say(fields, world) {
      const column = str(fields, 'slot_column');
      const name = fieldName(world, num(fields, 'field_id'));
      if (column === undefined || name === undefined) return null;

      const pageId = num(fields, 'page_id');
      const status = str(fields, 'status') ?? 'reserved';
      return {
        headlineKey: 'slotReserved.headline',
        headlineParams: { fieldName: name, column },
        detailKey: 'slotReserved.detail',
        detailParams: {
          status,
          pageInfo: pageId === undefined ? '' : ` on page ${pageId}`,
        },
      };
    },
  },

  promote_to_ready: {
    kind: 'field-indexed',
    section: 'query',
    tone: 'good',
    say(fields, world) {
      const name = fieldName(world, num(fields, 'field_id'));
      if (name === undefined) return null;

      return {
        headlineKey: 'fieldIndexed.headline',
        headlineParams: { fieldName: name },
        detailKey: 'fieldIndexed.detail',
      };
    },
  },

  retype_started: {
    kind: 'lifecycle-started',
    section: 'daemons',
    tone: 'neutral',
    say(fields, world) {
      const name = fieldName(world, num(fields, 'field_id'));
      if (name === undefined) return null;

      // The promote/demote tuple, read the way the initiator writes it rather
      // than from a separate flag: ADR 0024's identity diagonal is one code
      // path, and which direction it went is exactly this pair.
      const becomingFilterable = bool(fields, 'new_is_filterable') === true;
      if (!becomingFilterable) {
        return {
          headlineKey: 'retypeStarted.headlineDemote',
          headlineParams: { fieldName: name },
          detailKey: 'retypeStarted.detailDemote',
        };
      }

      // `deferred_assignment` is the ADR 0007 shape: the registry committed,
      // and no slot was free to reserve inside the same transaction.
      return bool(fields, 'deferred_assignment') === true
        ? {
            headlineKey: 'retypeStarted.headlineWaiting',
            headlineParams: { fieldName: name },
            detailKey: 'retypeStarted.detailWaiting',
          }
        : {
            headlineKey: 'retypeStarted.headlineIndexing',
            headlineParams: { fieldName: name },
            detailKey: 'retypeStarted.detailIndexing',
          };
    },
  },

  exhaustion_fallback: {
    kind: 'write-outran-index',
    section: 'daemons',
    tone: 'warn',
    say(fields) {
      const entryId = num(fields, 'entry_id');
      if (entryId === undefined) return null;

      return {
        headlineKey: 'exhaustionFallback.headline',
        detailKey: 'exhaustionFallback.detail',
        detailParams: { entryId },
      };
    },
  },

  dlq_inserted: {
    kind: 'row-quarantined',
    section: 'daemons',
    tone: 'warn',
    say(fields) {
      const entryId = num(fields, 'entry_id');
      const reason = str(fields, 'reason');
      if (entryId === undefined || reason === undefined) return null;

      return {
        headlineKey: 'dlqInserted.headline',
        headlineParams: { entryId },
        detailKey: 'dlqInserted.detail',
        detailParams: { reason },
      };
    },
  },

  pre_flight_rejected: {
    kind: 'filter-refused',
    section: 'query',
    tone: 'warn',
    say(fields, world, translate) {
      const reason = str(fields, 'reason');
      const name = str(fields, 'field_name');
      if (reason === undefined || name === undefined) return null;

      return {
        headlineKey: 'preFlightRejected.headline',
        detailKey: 'preFlightRejected.detail',
        detailParams: { reason: refusalDetail(reason, name, world, translate) },
      };
    },
  },

  rename_started: {
    kind: 'rename-in-flight',
    // Points at the tables rather than at the section the visitor just clicked
    // in, because the window is a thing you *look at*: `previous_name` goes
    // non-null in `stardust_fields` and every payload is still on the old key.
    section: 'tables',
    tone: 'neutral',
    say(fields) {
      const oldName = str(fields, 'old_name');
      const newName = str(fields, 'new_name');
      if (oldName === undefined || newName === undefined) return null;

      return {
        headlineKey: 'renameStarted.headline',
        headlineParams: { oldName, newName },
        detailKey: 'renameStarted.detail',
        detailParams: { oldName },
      };
    },
  },

  rename_complete: {
    kind: 'rename-landed',
    section: 'tables',
    tone: 'good',
    say(fields) {
      const newName = str(fields, 'new_name');
      if (newName === undefined) return null;

      return {
        headlineKey: 'renameComplete.headline',
        headlineParams: { newName },
        detailKey: 'renameComplete.detail',
      };
    },
  },

  delete_started: {
    kind: 'field-severed',
    section: 'tables',
    tone: 'warn',
    say(fields) {
      // Read off the event rather than looked up, and that is not a shortcut:
      // by the time the purge's final chunk runs there is no row to look up,
      // and a spec that resolved names from the world would narrate the
      // beginning of a deletion and go silent at the end of it.
      const name = str(fields, 'field_name');
      if (name === undefined) return null;

      return {
        headlineKey: 'fieldSevered.headline',
        headlineParams: { fieldName: name },
        detailKey: 'fieldSevered.detail',
      };
    },
  },

  delete_complete: {
    kind: 'field-purged',
    section: 'tables',
    tone: 'good',
    say(fields) {
      const name = str(fields, 'field_name');
      if (name === undefined) return null;

      return {
        headlineKey: 'fieldPurged.headline',
        headlineParams: { fieldName: name },
        detailKey: 'fieldPurged.detail',
      };
    },
  },

  model_delete_started: {
    kind: 'model-severed',
    // Reads go **dark** here rather than returning an error, which is the half
    // a visitor is least likely to predict — so the card points at the place
    // they can try it.
    section: 'query',
    tone: 'warn',
    say(fields) {
      const name = str(fields, 'model_name');
      const fieldCount = num(fields, 'field_count');
      if (name === undefined || fieldCount === undefined) return null;

      return {
        headlineKey: 'modelSevered.headline',
        headlineParams: { modelName: name },
        detailKey: 'modelSevered.detail',
        detailParams: { fieldCount },
      };
    },
  },

  model_delete_complete: {
    kind: 'model-purged',
    section: 'tables',
    tone: 'warn',
    say(fields) {
      const modelId = num(fields, 'model_id');
      if (modelId === undefined) return null;

      // Deliberately `warn` rather than `good`, unlike every other completion
      // here. This is the one drain in the engine that destroys rows, and
      // there is no undelete — a green card would be the wrong feeling.
      return {
        headlineKey: 'modelPurged.headline',
        headlineParams: { modelId },
        detailKey: 'modelPurged.detail',
      };
    },
  },

  sweep_complete: {
    kind: 'column-reclaimed',
    section: 'tables',
    tone: 'good',
    say(fields) {
      const slotId = num(fields, 'slot_assignment_id');
      if (slotId === undefined) return null;

      return {
        headlineKey: 'columnReclaimed.headline',
        detailKey: 'columnReclaimed.detail',
        detailParams: { slotId },
      };
    },
  },
};

/**
 * Why a filter was refused, in words.
 *
 * `field_not_filterable` covers two genuinely different situations — no slot
 * at all, and a slot that is still `backfilling` — and pre-flight collapses
 * them into one reason because the engine's taxonomy does. The world can tell
 * them apart, so the copy does: that gap between "the registry says
 * filterable" and "a filter works right now" *is* the promotion window, and
 * flattening it here would undo the section's whole lesson.
 *
 * The model comes from `queryDraft`, not from the log line. A rejection
 * carries `field_name` and no `model_id`, and inventing one on the event would
 * be adding a field the engine does not log — whereas the draft holds the
 * model whose query was just run, which is the same answer arrived at
 * honestly.
 */
function refusalDetail(reason: string, name: string, world: SimWorld, translate: Translate): string {
  switch (reason) {
    case 'field_unknown':
      return translate('rejectionReasons.fieldUnknown', { fieldName: name });

    case 'field_not_filterable': {
      const modelId = world.queryDraft.modelId;
      const field =
        modelId === null
          ? undefined
          : world.fields.find(
              f => f.modelId === modelId && f.name === name && f.deletedAt === null,
            );

      if (field !== undefined && fieldIndexState(world, field.id) === 'building') {
        return translate('rejectionReasons.fieldNotFilterableBuilding', { fieldName: name });
      }
      return translate('rejectionReasons.fieldNotFilterableNoSlot', { fieldName: name });
    }

    case 'value_type_mismatch':
      return translate('rejectionReasons.valueTypeMismatch', { fieldName: name });

    case 'value_out_of_bounds':
      return translate('rejectionReasons.valueOutOfBounds', { fieldName: name });

    case 'sort_field_unknown':
      return translate('rejectionReasons.sortFieldUnknown', { fieldName: name });

    case 'sort_field_not_sortable':
      return translate('rejectionReasons.sortFieldNotSortable', { fieldName: name });

    case 'cursor_sort_mismatch':
      return translate('rejectionReasons.cursorSortMismatch');

    default:
      // A reason this map has not caught up with. Naming it is better than
      // inventing a sentence about it.
      return translate('rejectionReasons.unknown', { reason });
  }
}

/* ------------------------------------------------------------------ *
 * The two entry points
 * ------------------------------------------------------------------ */

/**
 * One line, narrated — or `null` when it is not a milestone.
 *
 * `translate` defaults to English, for a plain Node process with no locale to
 * ask (`verify-narration.ts`) and for any other caller that has none in
 * scope. `useNarration` passes the real one, bound to whichever locale is
 * live — the only place in the render path that needs to know this map exists
 * at all.
 */
export function toMilestone(
  event: SimEvent,
  world: SimWorld,
  translate: Translate = defaultTranslate,
): Milestone | null {
  const spec = MILESTONES[event.event];
  if (spec === undefined) return null;

  const said = spec.say(event.fields, world, translate);
  if (said === null) return null;

  return {
    seq: event.seq,
    kind: spec.kind,
    section: spec.section,
    headline: translate(said.headlineKey, said.headlineParams),
    detail: translate(said.detailKey, said.detailParams),
    tone: spec.tone,
  };
}

/**
 * The highest `seq` the world has already handed out — a reader's "I have seen
 * everything up to here" mark.
 *
 * It exists so the off-by-one is written down once. `seq.event` is the *next*
 * id to be issued, not the last one issued, so a reader that marks its
 * position with `seq.event` and then asks for everything strictly above it
 * silently drops the very next line — which, for a burst emitted in one
 * commit, is the first and usually most important thing that happened. Both
 * readers here got that wrong independently before this function existed.
 */
export function readPosition(world: SimWorld): number {
  return world.seq.event - 1;
}

/**
 * Every milestone in the world's retained log above `seq`, oldest first.
 *
 * Pass a {@link readPosition} taken before the actions ran. `seq` is monotonic
 * and already lives on the world, so a caller's read position is one number —
 * which is the whole reason the feed needs no state on `SimWorld` and forces
 * no snapshot bump.
 */
export function milestonesSince(
  world: SimWorld,
  seq: number,
  translate: Translate = defaultTranslate,
): Milestone[] {
  const out: Milestone[] = [];
  for (const event of world.events) {
    if (event.seq <= seq) continue;
    const milestone = toMilestone(event, world, translate);
    if (milestone !== null) out.push(milestone);
  }
  return out;
}

/**
 * Collapse repeats, keeping the newest of each kind-and-section.
 *
 * The burst this is actually for is a Reconciler chunk full of poisoned rows:
 * `dlq_inserted` fires **once per row**, every one of them inside a single
 * `clock/tick`, bounded only by the chunk size. One tick also folds every due
 * daemon, so two or three unrelated milestones landing together is ordinary
 * rather than exceptional.
 *
 * It is deliberately *not* justified by the six-hundred-row seed, which is the
 * intuitive example and the wrong one: `bulkWriteEntries` logs at chunk level,
 * so seeding produces two lines rather than six hundred. `npm run
 * verify:scenarios` prints the worst single commit each scenario reaches, so
 * this claim stays measured rather than assumed.
 *
 * It lives here rather than in the hook that calls it because "these two lines
 * are the same thing happening twice" is a claim about the stream, not about
 * React — which also makes it checkable by a script with no browser in it.
 * What the hook adds on top is the one genuinely view-shaped field, the
 * arrival time its retirement timer counts from, and the merge against cards
 * already on screen, which is a fact about the screen rather than the stream.
 */
export function coalesce(milestones: Milestone[]): CoalescedMilestone[] {
  const collapsed = new Map<string, CoalescedMilestone>();

  for (const milestone of milestones) {
    const key = `${milestone.kind}:${milestone.section}`;
    const seen = collapsed.get(key);
    collapsed.set(key, { ...milestone, count: (seen?.count ?? 0) + 1 });
  }

  return [...collapsed.values()];
}
