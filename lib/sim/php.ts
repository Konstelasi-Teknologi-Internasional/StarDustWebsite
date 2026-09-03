/**
 * The builder's gestures, rendered as the call they correspond to.
 *
 * A visitor should never have to guess which API call a drag maps onto, so
 * the panel beside the model card shows the real thing, updating as they
 * type. It lives in `lib/sim/` next to `registry.ts` rather than in the
 * component because the two have to agree: if `createModel()`'s simulated
 * semantics change, the snippet claiming to be that call changes in the same
 * file move.
 *
 * The output is a real signature, not a sketch —
 * `createModel(int $tenantId, string $name, array $fields = [])` with
 * `FieldDefinition(string $name, string $declaredType, bool $isFilterable = false)`.
 */

import type { SimDraft } from './draft';
import { isLeaf, type FilterNode } from './filter/ast';

/**
 * A PHP variable name derived from the model's.
 *
 * Model names are `VARCHAR(128)` and may hold anything; PHP variables may
 * not. Anything outside `[A-Za-z0-9_]` collapses to an underscore and a
 * leading digit gets prefixed, which is enough for a snippet that is read
 * rather than executed.
 */
function variableName(modelName: string): string {
  const cleaned = modelName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (cleaned === '') return 'model';
  return /^\d/.test(cleaned) ? `m_${cleaned}` : cleaned;
}

/** PHP single-quoted strings escape exactly two characters. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function createModelSnippet(draft: SimDraft, tenantId: number): string {
  const name = draft.name.trim() === '' ? 'your_model' : draft.name;
  const variable = `$${variableName(name)}`;

  const head = `${variable} = $schema->createModel(${tenantId}, ${quote(name)}`;

  // The three-argument form only appears once there is something to put in
  // it — `$fields = []` is the default, and showing an empty array literal
  // would suggest the argument is required.
  if (draft.fields.length === 0) {
    return `${head});`;
  }

  const definitions = draft.fields
    .map(f => {
      // `$isFilterable = false` is the default, so the named argument is
      // shown only when it is doing something. That is also the honest
      // reading: a field is JSON-only unless you ask otherwise.
      const filterable = f.isFilterable ? ', isFilterable: true' : '';
      return `    new FieldDefinition(${quote(f.name)}, ${quote(f.declaredType)}${filterable}),`;
    })
    .join('\n');

  return `${head}, [\n${definitions}\n]);`;
}

/** The snippet with the boilerplate a copy-paste actually needs. */
export function createModelSnippetFull(draft: SimDraft, tenantId: number): string {
  return [
    'use StarDust\\Schema\\FieldDefinition;',
    '',
    '$schema = $stardust->schemaBuilder();',
    '',
    createModelSnippet(draft, tenantId),
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * The write path
 * ------------------------------------------------------------------ */

/** A payload value as a PHP literal. */
function phpValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return quote(String(value));
}

/**
 * `$stardust->write(new EntryPayload(...))`.
 *
 * Named arguments rather than positional. `EntryPayload`'s constructor is
 * positional, but the named form is valid PHP 8, is already this file's house
 * style, and makes `modelId` visibly distinct from `tenantId` — two bare
 * integers side by side is exactly the call a reader would get backwards.
 *
 * `fields` is always shown, even when empty. `createModelSnippet()` omits its
 * third argument because that one has a default; this one does not.
 */
export function writeEntrySnippet(
  fields: Record<string, unknown>,
  tenantId: number,
  modelId: number | null,
): string {
  const entries = Object.entries(fields);
  const head = `$result = $stardust->write(new EntryPayload(\n    tenantId: ${tenantId},\n    modelId: ${modelId ?? 0},`;

  if (entries.length === 0) {
    return `${head}\n    fields: [],\n));`;
  }

  // Align the `=>` the way the engine's own array literals do.
  const width = Math.max(...entries.map(([key]) => key.length));
  const body = entries
    .map(([key, value]) => `        ${quote(key).padEnd(width + 2)} => ${phpValue(value)},`)
    .join('\n');

  return `${head}\n    fields: [\n${body}\n    ],\n));`;
}

export function writeEntrySnippetFull(
  fields: Record<string, unknown>,
  tenantId: number,
  modelId: number | null,
): string {
  return [
    'use StarDust\\Write\\EntryPayload;',
    '',
    writeEntrySnippet(fields, tenantId, modelId),
    '',
    '// $result->entryId',
    '// $result->enqueuedForBackfill  — true when a field had no live slot',
    '// $result->slotsWritten         — the (pageId, slotColumn) pairs touched',
  ].join('\n');
}

/**
 * `$stardust->bulkWrite($payloads)`.
 *
 * The defaults are named in a comment rather than rendered as
 * `new BulkIngestOptions(chunkSize: 500)`, on this file's existing rule: an
 * argument appears only when it is doing something, and the seed never
 * overrides either default.
 */
/* ------------------------------------------------------------------ *
 * The read path
 * ------------------------------------------------------------------ */

/**
 * The decoded tree, as the PHP objects the decoder hands back.
 *
 * The wire format is what a gateway *receives*; this is what the rest of the
 * engine actually consumes — the pre-flight resolves these leaves, and the
 * compiler reads the operator and the resolved descriptor off them. Showing
 * both is the difference between "here is some JSON" and "here is the boundary
 * between the two".
 *
 * The classes and their constructor order are transcribed from
 * `src/Filter/Ast/`: `LeafNode(string $operator, FieldRef $field, ?TypedValue
 * $value)`, `FieldRef(string $modelName, string $fieldName)`,
 * `AndNode(array $args)`, `OrNode(array $args)`, `NotNode(FilterNode $arg)`.
 * `FieldRef` carries three further optional parameters — the resolved
 * `modelId`, `fieldId` and descriptor — which are deliberately absent here:
 * they are populated by pre-flight, not by the decoder, and rendering them
 * would show a tree at a stage this pane is not at.
 */
export function filterAstSnippet(node: FilterNode | null): string {
  if (node === null) {
    return [
      '// The envelope carried no `filter` key, so the decoder returns null.',
      '// null is the match-all signal, not an error.',
      '$filter = null;',
    ].join('\n');
  }
  return `$filter = ${renderNode(node, 0)};`;
}

function renderNode(node: FilterNode, depth: number): string {
  const pad = '    '.repeat(depth + 1);
  const close = '    '.repeat(depth);

  if (!isLeaf(node)) {
    if (node.op === 'not') {
      return `new NotNode(\n${pad}${renderNode(node.arg, depth + 1)},\n${close})`;
    }
    const className = node.op === 'and' ? 'AndNode' : 'OrNode';
    const args = node.args
      .map(child => `${pad}    ${renderNode(child, depth + 2)},`)
      .join('\n');
    return `new ${className}([\n${args}\n${pad}])`;
  }

  // `null` rather than a TypedValue is the structural invariant the decoder
  // enforces for the two presence operators, and it is worth seeing: the
  // absence of a value is typed, not encoded as an empty one.
  const value =
    node.value === undefined
      ? 'null'
      : `new TypedValue(${phpLiteral(node.value)})`;

  return (
    `new LeafNode(\n` +
    `${pad}${quote(node.op)},\n` +
    `${pad}new FieldRef(${quote(node.field.model)}, ${quote(node.field.name)}),\n` +
    `${pad}${value},\n` +
    `${close})`
  );
}

/** A decoded JSON value as the PHP literal `json_decode()` would have produced. */
function phpLiteral(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(phpLiteral).join(', ')}]`;
  return phpValue(value);
}

/** The `use` lines a copy-paste of the AST would need. */
export function filterAstSnippetFull(node: FilterNode | null): string {
  if (node === null) return filterAstSnippet(node);

  const used = new Set<string>();
  const walk = (n: FilterNode): void => {
    if (isLeaf(n)) {
      used.add('LeafNode');
      used.add('FieldRef');
      if (n.value !== undefined) used.add('TypedValue');
      return;
    }
    if (n.op === 'not') {
      used.add('NotNode');
      walk(n.arg);
      return;
    }
    used.add(n.op === 'and' ? 'AndNode' : 'OrNode');
    n.args.forEach(walk);
  };
  walk(node);

  const imports = [...used]
    .sort()
    .map(name => `use StarDust\\Filter\\Ast\\${name};`)
    .join('\n');

  return `${imports}\n\n${filterAstSnippet(node)}`;
}

/** `SortSpec::byField('city', SortDirection::Desc)`, or nothing at all. */
function sortArgument(target: string, fieldName: string | null, direction: string): string | null {
  const dir = direction === 'desc' ? 'SortDirection::Desc' : 'SortDirection::Asc';
  if (target === 'id') {
    // The default ordering is `null`, not `SortSpec::byId()` — showing the
    // explicit call for a read nobody sorted would suggest the parameter is
    // required, and it is the one parameter whose absence is the whole reason
    // existing callers were unaffected by ADR 0041.
    return direction === 'asc' ? null : `SortSpec::byId(${dir})`;
  }
  if (target === 'created_at') return `SortSpec::byCreatedAt(${dir})`;
  return `SortSpec::byField(${quote(fieldName ?? '')}, ${dir})`;
}

/**
 * `$stardust->search(new SearchRequest(...))`, with the wire format decoded
 * into it.
 *
 * The decoder is shown rather than elided because it is the seam a consumer
 * actually uses: a gateway receives JSON from its own client, and
 * `JsonFilterDecoder` is what turns that into the AST the request carries. A
 * snippet that constructed `LeafNode`s by hand would be valid PHP and the
 * wrong lesson.
 */
export function searchSnippet(
  tenantId: number,
  modelId: number | null,
  pageSize: number,
  sortTarget: string,
  sortFieldName: string | null,
  sortDirection: string,
  hasCursor: boolean,
): string {
  const sort = sortArgument(sortTarget, sortFieldName, sortDirection);
  const lines = [
    'use StarDust\\Filter\\Json\\JsonFilterDecoder;',
    'use StarDust\\Search\\SearchRequest;',
    ...(sort === null ? [] : ['use StarDust\\Read\\SortDirection;', 'use StarDust\\Read\\SortSpec;']),
    '',
    '$filter = (new JsonFilterDecoder())->decode($json);',
    '',
    '$result = $stardust->search(new SearchRequest(',
    `    tenantId: ${tenantId},`,
    `    modelId: ${modelId ?? 0},`,
    '    filter: $filter,',
    `    pageSize: ${pageSize},`,
    ...(hasCursor ? ['    cursor: $cursor,'] : []),
    ...(sort === null ? [] : [`    sort: ${sort},`]),
    '));',
    '',
    '// $result->rows        — this page only, never more than pageSize',
    '// $result->nextCursor  — null when there is no next page',
  ];
  return lines.join('\n');
}

/**
 * `$stardust->renameField()` — and the comment is most of the point.
 *
 * The call returns as soon as the registry commits, which is the thing a
 * consumer gets wrong: it looks synchronous, and the payload rewrite that makes
 * it true needs a Reconciler running. The snippet says so rather than leaving
 * the visitor to infer it from a section heading.
 */
export function renameFieldSnippet(
  tenantId: number,
  fieldId: number,
  oldName: string,
  newName: string,
): string {
  return [
    `// ${oldName} → ${newName}`,
    `$stardust->renameField(${tenantId}, ${fieldId}, ${quote(newName)});`,
    '',
    '// Returns once the registry commits. stardust_fields.previous_name now',
    '// holds the old name, and every stored payload is still keyed by it —',
    '// the Reconciler rewrites them in chunks. Reads and writes bridge that',
    '// window; filters naming the old field do not, on purpose.',
  ].join('\n');
}

/**
 * `$stardust->renameModel()` — the whole of it, including what it does not do.
 *
 * Shown next to `renameFieldSnippet()` because the contrast *is* the lesson:
 * two calls with the same shape, one of which is a migration and one of which
 * is a label change.
 *
 * `oldName === newName` is the ordinary case here rather than an edge one: the
 * panel renders this before anything has been typed, so the arrow is dropped
 * instead of rendering `// places → places`, which reads as a bug.
 */
export function renameModelSnippet(
  tenantId: number,
  modelId: number,
  oldName: string,
  newName: string,
): string {
  return [
    oldName === newName ? `// rename model ${modelId}` : `// ${oldName} → ${newName}`,
    `$stardust->renameModel(${tenantId}, ${modelId}, ${quote(newName)});`,
    '',
    '// Complete on return: one UPDATE, no checkpoint, no window. Identity is',
    '// stardust_models.id, so nothing keyed on the name had to move — and',
    '// stardust_schema_version is deliberately NOT bumped, because no cached',
    '// snapshot holds a model name.',
  ].join('\n');
}

/**
 * `$stardust->retypeField()` — and the two things about it that surprise people.
 *
 * It carries the field's current filterability forward rather than taking one,
 * and it reserves its replacement slot from the **target** family, which is why
 * a retype across families needs the Watcher exactly as a cold-start promotion
 * does.
 */
export function retypeFieldSnippet(
  tenantId: number,
  fieldId: number,
  from: string,
  to: string,
): string {
  return [
    `// ${from} → ${to}`,
    `$stardust->retypeField(${tenantId}, ${fieldId}, ${quote(to)});`,
    '',
    '// declared_type is overwritten now; the old one is stashed on the',
    '// checkpoint, because nothing else can recover it afterwards. The old',
    '// slot is tombstoned and a replacement is reserved from the target',
    "// family, then every value is rewritten through that one matrix cell.",
    '// Values that will not convert are written NULL with an audited reason —',
    '// never rounded, never truncated.',
  ].join('\n');
}

/**
 * `$stardust->deleteField()`.
 *
 * Returns `bool`, and the `false` case is the one worth commenting: it covers
 * three situations the engine deliberately makes indistinguishable.
 */
export function deleteFieldSnippet(tenantId: number, fieldId: number, name: string): string {
  return [
    `// delete ${name}`,
    `$deleted = $stardust->deleteField(${tenantId}, ${fieldId});`,
    '',
    '// true once severance commits — from that moment the field is invisible',
    '// to reads, filters, exports and describeModel(), while its values are',
    '// still in entry_data. The Reconciler strips the key in chunks and the',
    '// final chunk deletes the registry row.',
    '//',
    '// false means there was nothing to do: no such field, another tenant’s,',
    '// or a deletion already in flight. The three are deliberately',
    '// indistinguishable, which is what makes a repeated delete idempotent.',
  ].join('\n');
}

/**
 * `$stardust->deleteModel()`.
 *
 * The comment carries the warning rather than the prose around it, because
 * this is the snippet somebody copies.
 */
export function deleteModelSnippet(tenantId: number, modelId: number, name: string): string {
  return [
    `// delete ${name} — and every entry in it`,
    `$deleted = $stardust->deleteModel(${tenantId}, ${modelId});`,
    '',
    '// THE ONLY OPERATION IN THE ENGINE THAT DELETES entry_data ROWS.',
    '// There is no undelete. Severance marks the model and every field it',
    '// owns; the Reconciler then deletes the entries themselves, with their',
    '// stardust_sync_queue rows, and the final chunk drops the model row.',
    '//',
    '// Meanwhile reads go dark and writes are REFUSED rather than stripped —',
    '// the deliberate inversion of the field rule, because a deleted model',
    '// leaves no residual entry worth preserving.',
  ].join('\n');
}

export function bulkWriteSnippet(count: number, tenantId: number, modelId: number | null): string {
  return [
    'use StarDust\\Write\\EntryPayload;',
    '',
    `/** @var list<EntryPayload> $payloads — ${count} entries for model ${modelId ?? 0}, tenant ${tenantId} */`,
    '$result = $stardust->bulkWrite($payloads);',
    '',
    '// Up to 1,000 entities per call, in chunks of 500 — one transaction each.',
    '// Above the threshold this throws PayloadTooLargeException and you use',
    '// submitBulkWrite(), which queues a stardust_import_jobs row instead.',
    'foreach ($result->chunks as $chunk) {',
    '    // $chunk->chunkIndex, $chunk->outcome, $chunk->entryIds',
    '}',
  ].join('\n');
}

