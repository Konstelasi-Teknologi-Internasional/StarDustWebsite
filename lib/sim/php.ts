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
