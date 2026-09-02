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

