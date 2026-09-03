/**
 * Drive the schema-change lifecycles and assert what they do — including the
 * refusals, which nothing else here can reach.
 *
 * The third sibling of `verify-scenarios.ts` and `verify-narration.ts`, and it
 * makes a third kind of claim. Scenarios check that two scripted worlds park and
 * pay off where they promise. Narration checks that every mapped milestone can
 * occur at all. This one checks the **rules** — the guards that refuse, the
 * bridge that converges, and the negative facts that would otherwise be somebody
 * "fixing" an apparent oversight.
 *
 * Three of the checks here are worth more than the rest, because they cover code
 * that no click in the playground can reach:
 *
 *   - **`renameModel()` bumps no schema version.** It looks like an omission
 *     next to `renameField()`, which bumps twice. Pinned negatively, the way
 *     the engine's own `ModelRenameTest::testRenameDoesNotBumpSchemaVersion`
 *     is, so that a future contributor cannot quietly make it symmetric.
 *   - **The write-path bridge.** `canonicalise()` shipped in stage 3 and was
 *     unreachable until a rename could set `previous_name`. A client still
 *     sending the old key must land under the *new* one, and the engine's note
 *     is that the read-window hole is transient while this one is permanent:
 *     for a row the backfill has already passed, the value would disappear for
 *     good when the marker is cleared.
 *   - **A name collision against another field's `previous_name`.**
 *     `ux_fields_model_name` does not cover it, and renaming `a → b` frees `a`
 *     — so `y → a` would be accepted, and then field `b`'s read fallback would
 *     resolve to field `y`'s value on every un-migrated row.
 *
 * Run with `npm run verify:lifecycles`.
 */

import { coerceForRetype, isCategoricallyRejected } from '../lib/sim/backfill';
import { JOB_PREFIXES, checkpointFor } from '../lib/sim/checkpoints';
import { fieldPurgeCheckpoint, runningModelPurge } from '../lib/sim/delete';
import { reduce, type SimAction } from '../lib/sim/reduce';
import { runSearch } from '../lib/sim/search/execute';
import { snapshotForModel } from '../lib/sim/search/snapshot';
import type { DeclaredType } from '../lib/sim/types';
import { emptyWorld, fieldIndexState, fieldsOf, type SimWorld } from '../lib/sim/world';

let failed = false;
let checks = 0;

function check(label: string, problems: string[]): void {
  checks++;
  if (problems.length === 0) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failed = true;
  console.error(`  ✗ ${label}`);
  for (const problem of problems) console.error(`      ${problem}`);
}

function expect(ok: boolean, message: string): string[] {
  return ok ? [] : [message];
}

function fold(actions: SimAction[], start?: SimWorld): SimWorld {
  return actions.reduce(reduce, start ?? emptyWorld());
}

/** A two-field model with `n` entries, nothing filterable. Tick 0 throughout. */
function model(n: number): SimAction[] {
  return [
    { type: 'world/reset' },
    { type: 'draft/setName', name: 'places' },
    { type: 'draft/addField', declaredType: 'string' },
    { type: 'draft/patchField', key: 'd1', patch: { name: 'city' } },
    { type: 'draft/addField', declaredType: 'string' },
    { type: 'draft/patchField', key: 'd2', patch: { name: 'country' } },
    { type: 'registry/createModel' },
    { type: 'payload/selectModel', modelId: 1 },
    ...(n === 0 ? [] : [{ type: 'entry/seed', count: n } as SimAction]),
  ];
}

const CITY = 1;
const COUNTRY = 2;

/** `clock/tick` × n. */
function ticks(n: number): SimAction[] {
  return Array.from({ length: n }, (): SimAction => ({ type: 'clock/tick' }));
}

/**
 * What a read actually projects, which is the snapshot's fields and not the
 * stored payload — the distinction several checks below turn on.
 */
function readFields(world: SimWorld, modelId: number): Record<string, unknown>[] {
  const { result } = runSearch(
    world,
    { tenantId: world.tenantId, modelId, filter: null, sort: null, pageSize: 50, cursor: null },
    'verify',
  );
  return result.ok ? result.outcome.rows.map(r => r.fields) : [];
}

/* ------------------------------------------------------------------ *
 * The namespaces
 * ------------------------------------------------------------------ */

console.log('\nbackfill_checkpoints namespaces');

check(
  'all four job-name prefixes are thirteen characters',
  Object.entries(JOB_PREFIXES).flatMap(([kind, prefix]) =>
    expect(
      prefix.length === 13,
      `${kind} is '${prefix}' (${prefix.length} chars) — every claim query shares SUBSTRING(job_name, 14)`,
    ),
  ),
);

// Distinctness is the property that matters, and it has to be checked over the
// values rather than by comparing two of them: the literal types make
// `JOB_PREFIXES.deleteField !== JOB_PREFIXES.deleteModel` a compile error
// rather than a test.
check(
  'the four prefixes are distinct',
  expect(
    new Set(Object.values(JOB_PREFIXES)).size === Object.keys(JOB_PREFIXES).length,
    `expected four distinct prefixes, got ${[...new Set(Object.values(JOB_PREFIXES))].join(', ')}`,
  ),
);

/* ------------------------------------------------------------------ *
 * renameModel — synchronous, and bumps nothing
 * ------------------------------------------------------------------ */

console.log('\nrenameModel');

{
  const before = fold(model(0));
  const after = fold([{ type: 'model/rename', modelId: 1, name: 'locations' }], before);

  check('renames in place, complete on return', [
    ...expect(after.models[0]?.name === 'locations', `expected 'locations', got '${after.models[0]?.name}'`),
    ...expect(after.lastLifecycle?.error == null, `expected success, got '${after.lastLifecycle?.error}'`),
    ...expect(after.checkpoints.length === 0, 'expected no checkpoint — a model rename has no window'),
  ]);

  // The negative assertion. Nothing a cached snapshot holds changes, and
  // `stardust_schema_version` is a singleton, so a bump would invalidate every
  // model's snapshot in every process for no correctness benefit.
  check(
    'does NOT bump the schema version',
    expect(
      after.schemaVersion === before.schemaVersion,
      `expected version to stay at ${before.schemaVersion}, got ${after.schemaVersion}`,
    ),
  );

  check(
    'emits model_renamed and nothing else',
    expect(
      after.events.filter(e => e.event === 'model_renamed').length === 1,
      'expected exactly one model_renamed line',
    ),
  );

  const noop = fold([{ type: 'model/rename', modelId: 1, name: 'locations' }], after);
  check('the same name is a quiet no-op', [
    ...expect(noop.lastLifecycle?.error == null, `expected no error, got '${noop.lastLifecycle?.error}'`),
    ...expect(
      noop.events.filter(e => e.event === 'model_renamed').length === 1,
      'expected no second model_renamed line',
    ),
  ]);
}

/* ------------------------------------------------------------------ *
 * renameField — the guards
 * ------------------------------------------------------------------ */

console.log('\nrenameField guards');

function refusal(actions: SimAction[], start: SimWorld): string {
  return fold(actions, start).lastLifecycle?.error ?? '(accepted)';
}

{
  const base = fold(model(3));

  check(
    'an empty name is refused',
    expect(
      refusal([{ type: 'field/rename', fieldId: CITY, name: '   ' }], base).startsWith(
        'InvalidArgumentException',
      ),
      `got '${refusal([{ type: 'field/rename', fieldId: CITY, name: '   ' }], base)}'`,
    ),
  );

  check(
    'a name over 128 characters is refused',
    expect(
      refusal([{ type: 'field/rename', fieldId: CITY, name: 'x'.repeat(129) }], base).startsWith(
        'InvalidArgumentException',
      ),
      'expected InvalidArgumentException for a 129-character name',
    ),
  );

  check(
    'an unknown field is refused',
    expect(
      refusal([{ type: 'field/rename', fieldId: 99, name: 'anything' }], base).startsWith(
        'FieldNotFoundException',
      ),
      'expected FieldNotFoundException',
    ),
  );

  // Before the in-flight guards on purpose: re-issuing the same rename
  // mid-drain should be quiet rather than an error.
  {
    const same = fold([{ type: 'field/rename', fieldId: CITY, name: 'city' }], base);
    check('renaming to the same name is a quiet no-op', [
      ...expect(same.lastLifecycle?.error == null, `expected no error, got '${same.lastLifecycle?.error}'`),
      ...expect(same.checkpoints.length === 0, 'expected no checkpoint to open'),
      ...expect(
        same.schemaVersion === base.schemaVersion,
        'expected no version bump for a no-op rename',
      ),
    ]);
  }

  check(
    "a name already held by a sibling is refused",
    expect(
      refusal([{ type: 'field/rename', fieldId: CITY, name: 'country' }], base).startsWith(
        'FieldNameConflictException',
      ),
      'expected FieldNameConflictException against a current name',
    ),
  );

  // The subtle one. `ux_fields_model_name` does not cover it: renaming
  // city → locality frees `city`, so country → city would be accepted, and then
  // locality's read fallback would resolve to country's value on every row the
  // first backfill has not reached. Two fields, one key, no error.
  {
    const renaming = fold([{ type: 'field/rename', fieldId: CITY, name: 'locality' }], base);
    const message = refusal([{ type: 'field/rename', fieldId: COUNTRY, name: 'city' }], renaming);
    check("a name held only by a sibling's previous_name is refused", [
      ...expect(
        message.startsWith('FieldNameConflictException'),
        `expected FieldNameConflictException, got '${message}'`,
      ),
      ...expect(
        message.includes('pre-rename name'),
        'expected the message to say why — the two conflicts need different responses',
      ),
    ]);

    check(
      'a second rename of the same field is refused while the first drains',
      expect(
        refusal([{ type: 'field/rename', fieldId: CITY, name: 'town' }], renaming).startsWith(
          'RenameInProgressException',
        ),
        'expected RenameInProgressException',
      ),
    );

    check(
      'a promotion is refused while a rename drains',
      expect(
        refusal([{ type: 'field/promote', fieldId: CITY }], renaming).startsWith(
          'RenameInProgressException',
        ),
        'expected the retype initiator to refuse — its backfill locates values by NAME, ' +
          'so mid-rename every un-migrated row would silently write a NULL slot',
      ),
    );
  }

  {
    const promoted = fold([{ type: 'field/promote', fieldId: CITY }], base);
    check(
      'a rename is refused while a retype runs',
      expect(
        refusal([{ type: 'field/rename', fieldId: CITY, name: 'locality' }], promoted).startsWith(
          'RetypeInProgressException',
        ),
        'expected RetypeInProgressException',
      ),
    );
  }
}

/* ------------------------------------------------------------------ *
 * The drain
 * ------------------------------------------------------------------ */

console.log('\nrename backfill');

{
  // No entries at all. There is deliberately no "backfill required" branch —
  // the checkpoint opens anyway and the work source closes it on its first
  // tick, so `previous_name` is always cleared by the same code.
  const empty = fold([
    ...model(0),
    { type: 'field/rename', fieldId: CITY, name: 'locality' },
  ]);
  check('an empty model still opens a checkpoint', [
    ...expect(
      checkpointFor(empty, 'rename', CITY)?.status === 'running',
      'expected a running checkpoint even with no rows to rewrite',
    ),
    ...expect(
      empty.fields[0]?.previousName === 'city',
      'expected previous_name to be set regardless',
    ),
  ]);

  const drained = fold([{ type: 'clock/tick' }, { type: 'clock/tick' }], empty);
  check('and the first tick completes it', [
    ...expect(
      checkpointFor(drained, 'rename', CITY)?.status === 'completed',
      `expected completed, got '${checkpointFor(drained, 'rename', CITY)?.status}'`,
    ),
    ...expect(drained.fields[0]?.previousName === null, 'expected previous_name cleared'),
  ]);

  // Atomicity: the clear and the bump commit together. A reader refreshing its
  // snapshot between them would lose the fallback while un-migrated rows still
  // existed — which is unobservable in a single-threaded fold, so what is
  // checked is that both happened in the same tick.
  check(
    'the final chunk clears the marker and bumps the version together',
    expect(
      drained.schemaVersion === empty.schemaVersion + 1 &&
        drained.fields[0]?.previousName === null,
      `expected one bump and a cleared marker, got version ${drained.schemaVersion} ` +
        `(was ${empty.schemaVersion}) and previous_name '${drained.fields[0]?.previousName}'`,
    ),
  );
}

{
  // Guard two: a post-rename write wins over the stale key. Constructed by
  // writing under the *new* name into a row that still carries the old one,
  // which is exactly what a client that has redeployed mid-drain does.
  const mid = fold([
    ...model(3),
    { type: 'field/rename', fieldId: CITY, name: 'locality' },
  ]);

  const target = mid.entries[0];
  const rigged: SimWorld = {
    ...mid,
    entries: mid.entries.map(e =>
      e.id === target.id ? { ...e, fields: { ...e.fields, locality: 'winner' } } : e,
    ),
  };

  const after = fold([{ type: 'clock/tick' }, { type: 'clock/tick' }], rigged);
  const rewritten = after.entries.find(e => e.id === target.id);
  check('a row already carrying the new key is not clobbered by the old value', [
    ...expect(
      rewritten?.fields.locality === 'winner',
      `expected the newer value to survive, got '${String(rewritten?.fields.locality)}'`,
    ),
    // The old key is left in place by the guard rather than removed, matching
    // the engine: the whole row fails the UPDATE's WHERE clause, so neither
    // half of the JSON_REMOVE(JSON_SET(…)) runs.
    ...expect(
      'city' in (rewritten?.fields ?? {}),
      'expected the skipped row to keep its old key — the guard skips the row, not the removal',
    ),
  ]);
}

/* ------------------------------------------------------------------ *
 * The write-path bridge
 * ------------------------------------------------------------------ */

console.log('\nthe write path during a rename');

{
  const mid = fold([
    ...model(2),
    { type: 'field/rename', fieldId: CITY, name: 'locality' },
  ]);

  // A client that has not redeployed: still sending `city`. The payload form is
  // built from the registry and offers only `locality`, so this is reached
  // through an invented key — which is exactly the shape the engine has to
  // defend against, since an unregistered key is *preserved* verbatim.
  const written = fold(
    [
      { type: 'payload/addUnknownKey' },
      { type: 'payload/renameKey', key: 'u1', name: 'city' },
      { type: 'payload/setValue', name: 'city', value: 'aurora' },
      { type: 'payload/setValue', name: 'country', value: 'nowhere' },
      { type: 'entry/write' },
    ],
    mid,
  );

  const fresh = written.entries[written.entries.length - 1];
  check('an inbound old key is canonicalised onto the new name', [
    ...expect(
      fresh?.fields.locality === 'aurora',
      `expected the value under 'locality', got '${String(fresh?.fields.locality)}'`,
    ),
    // The permanent half of the hazard: left un-rewritten, this key would sit
    // on a row the backfill cursor has already passed and would never migrate.
    ...expect(
      !('city' in (fresh?.fields ?? {})),
      'expected the old key to be gone from the stored payload',
    ),
  ]);
}

/* ------------------------------------------------------------------ *
 * The ADR 0024 matrix
 * ------------------------------------------------------------------ */

console.log('\nretype coercion matrix');

/**
 * A representative cell per behaviour, **not** an exhaustive table.
 *
 * The exhaustive check is not a unit test and could not be: it was a 96-case
 * corpus run through the engine's own `RetypeCoercionEngine` in PHP and diffed
 * case by case — the discipline stage 3 used for `PayloadSplitter` and stage 5
 * for `JsonFilterDecoder`. Result, 2026-09-03: **zero disagreements on outcome
 * or reason across all 96**, and nine value differences, every one of them a
 * JavaScript number-model limit rather than a rule:
 *
 *   - Two are integers above 2^53 (`9223372036854775807` comes back as
 *     `9223372036854776000`), which `write.ts` already records: the world has
 *     to stay JSON-serialisable for the snapshot, and this is a browser limit
 *     rather than an engine one.
 *   - Seven are PHP's `float` where JavaScript has one number type, so `(float)
 *     42` is `42.0` there and `42` here. Numerically equal; the same divergence
 *     the roadmap already records for the `in` dedupe.
 *
 * What lives here is the handful of cells whose *rule* would be easy to break
 * silently later.
 */
function cell(
  from: DeclaredType,
  to: DeclaredType,
  value: unknown,
): { kind: string; value?: unknown; reason?: string } {
  const r = coerceForRetype({ f: value }, 'f', from, to);
  return r.kind === 'coerced'
    ? { kind: r.kind, value: r.value }
    : r.kind === 'null_coerced'
      ? { kind: r.kind, reason: r.reason }
      : { kind: r.kind };
}

check(
  'the four categorical refusals refuse',
  (['int', 'numeric'] as DeclaredType[]).flatMap(t => [
    ...expect(
      isCategoricallyRejected(t, 'datetime'),
      `expected ${t} → datetime to be refused`,
    ),
    ...expect(
      isCategoricallyRejected('datetime', t),
      `expected datetime → ${t} to be refused`,
    ),
  ]),
);

check(
  'and nothing else is',
  (['string', 'int', 'numeric', 'datetime'] as DeclaredType[]).flatMap(from =>
    (['string', 'int', 'numeric', 'datetime'] as DeclaredType[])
      .filter(to => !(from === 'datetime' || to === 'datetime') || from === to)
      .flatMap(to =>
        expect(!isCategoricallyRejected(from, to), `expected ${from} → ${to} to be allowed`),
      ),
  ),
);

check('numeric → int truncates nothing', [
  ...expect(cell('numeric', 'int', 4.0).value === 4, 'expected 4.0 to become 4'),
  // **No rounding and no truncation.** A silent 2 here would be a wrong value
  // in an index nobody could audit, so the matrix writes NULL and says why.
  ...expect(
    cell('numeric', 'int', 2.5).reason === 'non_integer',
    `expected non_integer for 2.5, got ${JSON.stringify(cell('numeric', 'int', 2.5))}`,
  ),
]);

check('string → datetime demands an explicit offset', [
  ...expect(
    cell('string', 'datetime', '2026-01-01T10:00:00Z').value === '2026-01-01 10:00:00',
    'expected a Z-suffixed value to normalise to the slot format',
  ),
  ...expect(
    cell('string', 'datetime', '2026-01-01T10:00:00+07:00').value === '2026-01-01 03:00:00',
    'expected the offset to be applied, not discarded',
  ),
  // Naive is refused: there is no server timezone to read it in.
  ...expect(
    cell('string', 'datetime', '2026-01-01T10:00:00').reason === 'malformed_datetime',
    'expected a naive datetime to be refused',
  ),
]);

check('string → numeric uses the JSON grammar, not is_numeric()', [
  ...expect(cell('string', 'numeric', '4.5').value === 4.5, 'expected 4.5'),
  // All three are `is_numeric()` in PHP and are *not* JSON numbers. The write
  // path accepts them; this does not. Two rules for two jobs.
  ...expect(cell('string', 'numeric', '+3').reason === 'malformed_number', 'expected +3 refused'),
  ...expect(cell('string', 'numeric', '.5').reason === 'malformed_number', 'expected .5 refused'),
  ...expect(cell('string', 'numeric', '01').reason === 'malformed_number', 'expected 01 refused'),
]);

check('numeric → string is canonical decimal, never scientific', [
  ...expect(cell('numeric', 'string', 0).value === '0', 'expected 0'),
  ...expect(cell('numeric', 'string', -0).value === '0', 'expected -0 normalised to 0'),
  ...expect(cell('numeric', 'string', 2.0).value === '2', 'expected no trailing .0'),
  ...expect(
    String(cell('numeric', 'string', 1e-7).value ?? '').includes('e') === false,
    `expected fixed notation, got ${JSON.stringify(cell('numeric', 'string', 1e-7))}`,
  ),
]);

{
  const base = fold([
    { type: 'world/reset' },
    { type: 'draft/setName', name: 'places' },
    { type: 'draft/addField', declaredType: 'int' },
    { type: 'draft/patchField', key: 'd1', patch: { name: 'population' } },
    { type: 'registry/createModel' },
  ]);
  const refused = fold(
    [{ type: 'field/retype', fieldId: CITY, declaredType: 'datetime' }],
    base,
  );
  check('int → datetime is refused with nothing written', [
    ...expect(
      (refused.lastLifecycle?.error ?? '').startsWith('IncompatibleRetypeException'),
      `expected IncompatibleRetypeException, got '${refused.lastLifecycle?.error}'`,
    ),
    ...expect(
      refused.fields[0]?.declaredType === 'int',
      'expected the field row untouched — the guard runs before any mutation',
    ),
    ...expect(
      refused.schemaVersion === base.schemaVersion,
      'expected no version bump for a refused retype',
    ),
    ...expect(refused.checkpoints.length === 0, 'expected no checkpoint to open'),
  ]);
}

{
  // A real retype end to end, over a filterable field with rows behind it.
  const base = fold([
    { type: 'world/reset' },
    { type: 'draft/setName', name: 'places' },
    { type: 'draft/addField', declaredType: 'string' },
    { type: 'draft/patchField', key: 'd1', patch: { name: 'population' } },
    { type: 'registry/createModel' },
    { type: 'payload/selectModel', modelId: 1 },
    { type: 'payload/setValue', name: 'population', value: '42' },
    { type: 'entry/write' },
    { type: 'field/promote', fieldId: CITY },
    ...ticks(8),
  ]);

  check('the fixture is an indexed string field', [
    ...expect(fieldIndexState(base, CITY) === 'live', `got '${fieldIndexState(base, CITY)}'`),
    ...expect(base.pages[0]?.indexedColumns.includes('i_str_01') ?? false, 'expected i_str_01 indexed'),
  ]);

  const retyped = fold([{ type: 'field/retype', fieldId: CITY, declaredType: 'int' }], base);
  check('a retype overwrites the type and stashes the old one on the checkpoint', [
    ...expect(retyped.fields[0]?.declaredType === 'int', 'expected declared_type overwritten'),
    ...expect(
      checkpointFor(retyped, 'retype', CITY)?.sourceDeclaredType === 'string',
      // The field row cannot answer this any more — that is the entire reason
      // `backfill_checkpoints.source_declared_type` exists.
      `expected source_declared_type 'string', got '${checkpointFor(retyped, 'retype', CITY)?.sourceDeclaredType}'`,
    ),
    ...expect(
      retyped.slots.some(s => s.status === 'tombstoned'),
      'expected the old string slot tombstoned',
    ),
  ]);

  const drained = fold(ticks(10), retyped);
  check('and the backfill rewrites the slot through the right matrix cell', [
    ...expect(
      fieldIndexState(drained, CITY) === 'live',
      `expected the new slot live, got '${fieldIndexState(drained, CITY)}'`,
    ),
    ...expect(
      drained.slots.some(s => s.fieldId === CITY && s.slotColumn.startsWith('i_int_')),
      // The replacement must come from the *target* family, not the source's.
      `expected an int-family slot, got '${drained.slots.find(s => s.fieldId === CITY)?.slotColumn}'`,
    ),
    ...expect(
      Object.values(drained.entries[0]?.slots ?? {}).some(cols =>
        Object.values(cols).includes(42),
      ),
      // Coerced to the number 42 in the slot; the payload still holds the
      // string "42", which is the write path's documented asymmetry.
      'expected the value coerced to the integer 42 in its new slot',
    ),
    ...expect(
      drained.entries[0]?.fields.population === '42',
      'expected the JSON payload to still hold the raw string',
    ),
  ]);
}

/* ------------------------------------------------------------------ *
 * Field deletion — ADR 0037
 * ------------------------------------------------------------------ */

console.log('\ndeleteField');

{
  const base = fold([...model(3), { type: 'field/promote', fieldId: CITY }, ...ticks(8)]);

  check('the fixture is a filterable field holding a live slot', [
    ...expect(fieldIndexState(base, CITY) === 'live', `expected city indexed, got '${fieldIndexState(base, CITY)}'`),
    ...expect(base.slots.some(s => s.fieldId === CITY), 'expected a slot held by city'),
  ]);

  const severed = fold([{ type: 'field/delete', fieldId: CITY }], base);
  const field = severed.fields.find(f => f.id === CITY);

  check('severance is synchronous and total', [
    ...expect(field?.deletedAt !== null, 'expected deleted_at to be set'),
    // Load-bearing: left set, the Watcher provisions a page for a field being
    // deleted and the exhaustion reserver re-takes the foreign key, so the
    // purge's final delete fails permanently with nothing to retry it.
    ...expect(field?.isFilterable === false, 'expected is_filterable cleared in the same update'),
    ...expect(
      severed.slots.every(s => s.fieldId !== CITY),
      'expected the live slot to have field_id nulled — that is what releases the FK',
    ),
    ...expect(
      severed.slots.some(s => s.status === 'tombstoned'),
      'expected the slot handed to the Liberator as tombstoned',
    ),
    ...expect(
      severed.schemaVersion === base.schemaVersion + 1,
      'expected exactly one version bump',
    ),
    ...expect(
      fieldPurgeCheckpoint(severed, CITY)?.status === 'running',
      'expected a running purge checkpoint',
    ),
  ]);

  check('it disappears from the registry read immediately', [
    ...expect(
      !fieldsOf(severed, 1).some(f => f.id === CITY),
      'expected fieldsOf() to exclude it',
    ),
    ...expect(
      snapshotForModel(severed, 1)?.fieldsByName.city === undefined,
      'expected the read snapshot to exclude it',
    ),
  ]);

  // **The fixture proof.** Every assertion above is of the form "the API stops
  // showing it", which passes for free if the purge already finished. This is
  // what makes them mean something.
  check(
    'and its values are still sitting in storage',
    expect(
      severed.entries.every(e => 'city' in e.fields),
      'expected every raw payload to still carry the key — otherwise the checks above are vacuous',
    ),
  );

  check(
    'a read no longer projects it',
    expect(
      readFields(severed, 1).every(row => !('city' in row)),
      'expected the deleted key to be absent from a read result',
    ),
  );

  // Stripped, not refused — the inversion of the model rule below. An
  // unregistered key would otherwise be *preserved* verbatim, so a client still
  // sending the old name would write the field back into every new entry
  // indefinitely and the deletion would never complete in any observable sense.
  {
    const written = fold(
      [
        { type: 'payload/addUnknownKey' },
        { type: 'payload/renameKey', key: 'u1', name: 'city' },
        { type: 'payload/setValue', name: 'city', value: 'ghost' },
        { type: 'entry/write' },
      ],
      severed,
    );
    const fresh = written.entries[written.entries.length - 1];
    check('a write carrying the deleted key has it stripped, not refused', [
      ...expect(written.payloadDraft.error === null, `expected the write to succeed, got '${written.payloadDraft.error}'`),
      ...expect(!('city' in (fresh?.fields ?? {})), 'expected the key to be dropped from the stored payload'),
    ]);
  }

  check(
    'the name is not reusable while the purge is in flight',
    expect(
      (fold([{ type: 'registry/createModel' }], severed).draft.error ?? '').startsWith(
        'FieldDeletionInProgressException',
      ),
      'expected get-or-create to refuse the name rather than adopt the dying row',
    ),
  );

  {
    const again = fold([{ type: 'field/delete', fieldId: CITY }], severed);
    check('a second delete is a no-op, not an error', [
      ...expect(again.lastLifecycle?.error == null, `expected no error, got '${again.lastLifecycle?.error}'`),
      ...expect(again.lastLifecycle?.noop === true, 'expected it to report doing nothing'),
    ]);
  }

  // The drain. Two ticks: the Reconciler is due at 2, and three rows is one
  // chunk, so the first claim is also the final one.
  const purged = fold(ticks(2), severed);
  check('the final chunk drops the field row and its checkpoint', [
    ...expect(
      purged.fields.every(f => f.id !== CITY),
      'expected the registry row to be gone',
    ),
    ...expect(
      fieldPurgeCheckpoint(purged, CITY) === undefined,
      'expected the checkpoint row deleted, not marked completed — the field it keys on is gone',
    ),
    ...expect(
      purged.entries.every(e => !('city' in e.fields)),
      'expected every payload stripped',
    ),
    // The version bump is asserted on the JSON-only fixture below instead. Here
    // it cannot be exact: severance tombstoned a slot, so the Liberator is
    // legitimately sweeping and reclaiming during these same two ticks, and its
    // reclaim bumps the version too. An "exactly one more" assertion here was
    // red for that reason and was measuring the wrong world, not a defect.
  ]);

  check(
    'and the name is reusable again once it lands',
    expect(
      fold([{ type: 'registry/createModel' }], purged).draft.error === null,
      'expected get-or-create to accept the name after the purge',
    ),
  );

  // ADR 0029: the sweep keys on page, column and cursor and never joins
  // `stardust_fields`, which is exactly what lets it reclaim a slot whose field
  // row is already gone.
  const reclaimed = fold(ticks(14), purged);
  check(
    'the orphaned tombstone still reclaims with the field row gone',
    expect(
      reclaimed.slots.every(s => s.status !== 'tombstoned'),
      `expected every tombstone swept back to free, got ${reclaimed.slots
        .filter(s => s.status === 'tombstoned')
        .length} left`,
    ),
  );
}

{
  // A JSON-only field, which under ADR 0034 is the common case: it holds no
  // slot at all, so nothing is tombstoned, the Liberator has no work, and the
  // version arithmetic across the drain is exactly the purge's own.
  const base = fold(model(3));
  const severed = fold([{ type: 'field/delete', fieldId: COUNTRY }], base);

  check('deleting a JSON-only field touches no slot', [
    ...expect(severed.slots.length === 0, `expected no slot rows at all, got ${severed.slots.length}`),
    ...expect(
      severed.schemaVersion === base.schemaVersion + 1,
      'expected exactly one bump at severance',
    ),
  ]);

  const purged = fold(ticks(2), severed);
  check('and the final chunk bumps exactly once more, with the row and checkpoint', [
    ...expect(
      purged.schemaVersion === severed.schemaVersion + 1,
      `expected one more bump, got ${purged.schemaVersion - severed.schemaVersion}`,
    ),
    ...expect(purged.fields.every(f => f.id !== COUNTRY), 'expected the registry row dropped'),
    ...expect(
      fieldPurgeCheckpoint(purged, COUNTRY) === undefined,
      'expected the checkpoint deleted in the same chunk',
    ),
  ]);
}

{
  const base = fold(model(3));
  const renaming = fold([{ type: 'field/rename', fieldId: CITY, name: 'locality' }], base);
  check(
    'a delete is refused while a rename drains',
    expect(
      (fold([{ type: 'field/delete', fieldId: CITY }], renaming).lastLifecycle?.error ?? '').startsWith(
        'RenameInProgressException',
      ),
      'expected RenameInProgressException — deleting mid-backfill would strand a checkpoint no worker can claim',
    ),
  );

  const promoting = fold([{ type: 'field/promote', fieldId: CITY }], base);
  check(
    'a delete is refused while a retype drains',
    expect(
      (fold([{ type: 'field/delete', fieldId: CITY }], promoting).lastLifecycle?.error ?? '').startsWith(
        'RetypeInProgressException',
      ),
      'expected RetypeInProgressException',
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Model deletion — ADR 0038
 * ------------------------------------------------------------------ */

console.log('\ndeleteModel');

{
  const base = fold([...model(3), { type: 'field/promote', fieldId: CITY }, ...ticks(8)]);
  const severed = fold([{ type: 'model/delete', modelId: 1 }], base);

  check('severance marks the model and every field it owns', [
    ...expect(severed.models[0]?.deletedAt !== null, 'expected the model marker'),
    ...expect(
      severed.fields.every(f => f.modelId !== 1 || (f.deletedAt !== null && !f.isFilterable)),
      'expected every field severed too — that is what makes the existing guards fire with no new predicates',
    ),
    ...expect(
      severed.slots.every(s => s.fieldId === null || s.fieldId >= 3),
      'expected every slot of the model tombstoned with field_id nulled',
    ),
  ]);

  // The pin ADR 0038 turns on: a guard derived only from the field markers has
  // to read "no field of this model is live", which is true of every brand-new
  // empty model — and a model registered with no fields is legal.
  {
    const fieldless = fold([
      { type: 'world/reset' },
      { type: 'draft/setName', name: 'empty' },
      { type: 'registry/createModel' },
      { type: 'model/delete', modelId: 1 },
    ]);
    check('a fieldless model is severed and opens a claimable checkpoint', [
      ...expect(fieldless.lastLifecycle?.noop !== true, 'expected the deletion to be accepted'),
      ...expect(fieldless.models[0]?.deletedAt !== null, 'expected the model marker to be set'),
      ...expect(
        runningModelPurge(fieldless, 1) !== undefined,
        'expected a running model purge — with no fields, the model marker is the only thing to claim through',
      ),
    ]);
  }

  check('reads go dark rather than erroring', [
    ...expect(snapshotForModel(severed, 1) === null, 'expected no snapshot at all'),
    ...expect(
      runSearch(
        severed,
        { tenantId: 1, modelId: 1, filter: null, sort: null, pageSize: 10, cursor: null },
        'x',
      ).result.ok === false,
      'expected the search to return nothing',
    ),
  ]);

  // **The inversion.** A deleted field's key is stripped because a rejected
  // write loses data while a strip converges; for a model there is no residual
  // valid entry, so the row would land either behind the purge cursor (making
  // the acceptance a lie) or ahead of it (a permanent orphan).
  {
    const attempted = fold(
      [{ type: 'payload/setValue', name: 'country', value: 'nowhere' }, { type: 'entry/write' }],
      severed,
    );
    check('writes are refused, not stripped', [
      ...expect(
        (attempted.payloadDraft.error ?? '').includes('being deleted'),
        `expected a refusal, got '${attempted.payloadDraft.error ?? 'accepted'}'`,
      ),
      ...expect(
        attempted.entries.length === severed.entries.length,
        'expected no row to be written',
      ),
    ]);
  }

  // Section E's panel has to *say* the model went dark. Before this, a run
  // against a deleting model left `lastRun` untouched, so the panel went on
  // rendering the previous successful result over a model being destroyed —
  // a hole section F opened in a section that shipped two stages earlier.
  {
    const ran = fold(
      [
        { type: 'query/selectModel', modelId: 1 },
        { type: 'query/run' },
        { type: 'model/delete', modelId: 1 },
        { type: 'query/run' },
      ],
      fold([...model(3), { type: 'field/promote', fieldId: CITY }, ...ticks(8)]),
    );
    check('a read against a deleting model reports going dark', [
      ...expect(ran.queryDraft.lastRun?.dark === true, 'expected the run to be marked dark'),
      ...expect(
        ran.queryDraft.lastRun?.outcome === null,
        'expected no stale outcome left on the draft',
      ),
      ...expect(
        ran.queryDraft.lastRun?.rejection === null,
        'expected no rejection — going dark is not a refusal',
      ),
    ]);
  }

  check(
    'deleteEntry returns false rather than throwing',
    expect(
      fold([{ type: 'entry/delete', entryId: 1 }], severed).payloadDraft.lastDelete?.deleted === false,
      'expected a no-op delete',
    ),
  );

  const purged = fold(ticks(2), severed);
  check('the purge destroys rows, not keys', [
    ...expect(
      purged.entries.every(e => e.modelId !== 1),
      `expected every entry deleted, got ${purged.entries.filter(e => e.modelId === 1).length} left`,
    ),
    ...expect(purged.models.every(m => m.id !== 1), 'expected the model row dropped'),
    ...expect(
      purged.fields.every(f => f.modelId !== 1),
      'expected the field rows cascaded away by fk_fields_model',
    ),
    ...expect(
      runningModelPurge(purged, 1) === undefined,
      'expected the checkpoint deleted on the final chunk',
    ),
  ]);

}

{
  // **This fixture took three attempts, and the two failures are the point.**
  //
  // The obvious version deletes a model whose fields are all JSON-only, so
  // nothing ever enqueues and the queue is empty before the purge as well as
  // after — an assertion that cannot fail. Neutering the purge's queue deletion
  // and watching the check stay green is what found it.
  //
  // The second version filled the queue by promoting a field with the Watcher
  // stopped. That opens a retype checkpoint which stays `running`, so the model
  // delete was *correctly refused* and the check measured nothing at all.
  //
  // The third is this one, and it is the only construction where the purge is
  // observably the thing that deletes the rows: **two models sharing the sync
  // queue**, one of them being deleted and the other with a filterable field
  // the stopped Watcher will never provision for. The sync drain claims the
  // whole chunk, cannot map the second model's rows, and rolls back *whole* —
  // leaving the doomed model's rows in place for the purge to take. In every
  // other arrangement the sync drain simply gets there first, because it is
  // source 1 and the purge is source 6.
  //
  // That is also the exact situation ADR 0038 names: a blocked sync drain is
  // what leaves survivors behind, and a survivor with no `entry_data` row is a
  // `missing_entry_data` dead letter.
  const shared = fold([
    { type: 'world/reset' },
    { type: 'daemon/togglePaused', daemon: 'watcher' },
    { type: 'draft/setName', name: 'doomed' },
    { type: 'draft/addField', declaredType: 'string' },
    // Filterable at registration, not promoted — see above.
    { type: 'draft/patchField', key: 'd1', patch: { name: 'city', isFilterable: true } },
    { type: 'registry/createModel' },
    { type: 'payload/selectModel', modelId: 1 },
    { type: 'entry/seed', count: 3 },
    { type: 'draft/reset' },
    { type: 'draft/setName', name: 'other' },
    { type: 'draft/addField', declaredType: 'string' },
    { type: 'draft/patchField', key: 'd1', patch: { name: 'label', isFilterable: true } },
    { type: 'registry/createModel' },
    { type: 'payload/selectModel', modelId: 2 },
    { type: 'entry/seed', count: 3 },
    { type: 'model/delete', modelId: 1 },
  ]);

  check('the fixture leaves both models queued and the drain blocked', [
    ...expect(shared.syncQueue.length === 6, `expected 6 queue rows, got ${shared.syncQueue.length}`),
    ...expect(shared.models.length === 2, 'expected the surviving model to still exist'),
  ]);

  const purged = fold(ticks(2), shared);
  check('the sync queue rows die in the same chunk as the entries', [
    ...expect(
      purged.entries.every(e => e.modelId !== 1),
      'expected the doomed entries deleted',
    ),
    ...expect(
      purged.syncQueue.length === 3,
      `expected only the surviving model's 3 rows left, got ${purged.syncQueue.length} — a survivor of the doomed model would find no entry_data row and file a missing_entry_data dead letter`,
    ),
    ...expect(
      purged.syncQueue.every(r => r.entryId > 3),
      "expected every remaining queue row to belong to the model that is not being deleted",
    ),
    ...expect(purged.dlq.length === 0, `expected no dead letters, got ${purged.dlq.length}`),
  ]);
}

{
  const renaming = fold([
    ...model(3),
    { type: 'field/rename', fieldId: CITY, name: 'locality' },
  ]);
  check(
    'a model delete is refused while any field of it has a lifecycle running',
    expect(
      (fold([{ type: 'model/delete', modelId: 1 }], renaming).lastLifecycle?.error ?? '').startsWith(
        'RenameInProgressException',
      ),
      'expected RenameInProgressException naming the model',
    ),
  );
}

console.log('');
if (failed) {
  process.exitCode = 1;
} else {
  console.log(`${checks} lifecycle checks passed.`);
}
