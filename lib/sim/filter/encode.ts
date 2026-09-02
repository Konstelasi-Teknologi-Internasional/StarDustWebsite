/**
 * The other half of the round-trip: a tree, as the JSON a gateway would send.
 *
 * The engine has no encoder — it only ever receives wire format — so this has
 * no counterpart to be transcribed from, and the one rule it must hold is that
 * {@link encodeEnvelope}'s output is accepted by `decodeFilter()` and decodes
 * back to the tree it started from. That round-trip is the section's claim:
 * the thing the builder produces *is* the thing your gateway sends, not a
 * rendering of it.
 *
 * Key order is chosen for reading, not for the format — JSON objects are
 * unordered and the decoder looks up by key. `op` leads every node because it
 * is what decides how to read the rest.
 */

import { isLeaf, type FilterNode } from './ast';

/** The envelope, pretty-printed at two spaces — what the wire pane shows. */
export function encodeEnvelope(filter: FilterNode | null): string {
  // A null filter is the match-all signal, and it is spelled by *omitting* the
  // key. Writing `"filter": null` would be the one shape the decoder singles
  // out for rejection, so the empty builder must not produce it.
  const envelope = filter === null ? { version: '1' } : { version: '1', filter: order(filter) };
  return JSON.stringify(envelope, null, 2);
}

/** Just the filter node, for a panel that has its own envelope context. */
export function encodeNode(filter: FilterNode): string {
  return JSON.stringify(order(filter), null, 2);
}

/**
 * Rebuild a node with its keys in reading order.
 *
 * `JSON.stringify` follows insertion order for string keys, so this is what
 * decides the shape on screen. A node built by the reducer already has them in
 * this order; one that came back from `decodeFilter()` after the visitor typed
 * into the pane may not, and the pane re-rendering the visitor's own text with
 * the keys shuffled would read as the page fighting them.
 */
function order(node: FilterNode): Record<string, unknown> {
  if (isLeaf(node)) {
    const out: Record<string, unknown> = {
      op: node.op,
      field: { model: node.field.model, name: node.field.name },
    };
    // Absent rather than null for the presence operators: a `value` key at all
    // is `value_unexpected`, so emitting one would make the encoder produce
    // envelopes its own decoder rejects.
    if ('value' in node && node.value !== undefined) out.value = node.value;
    return out;
  }
  if (node.op === 'not') {
    return { op: node.op, arg: order(node.arg) };
  }
  return { op: node.op, args: node.args.map(order) };
}
