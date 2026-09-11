/**
 * The pure half of message lookup — no React, no context, no hook.
 *
 * `lib/sim/notify.ts` narrates milestones from a module that has to stay
 * importable by a plain Node process (`tsconfig.scripts.json` emits it to
 * CommonJS for `verify-narration.ts` and friends), so it cannot call
 * `useTranslations()`. This file is the seam: `createTranslator()` binds one
 * message-tree namespace and hands back the same `(key, params) => string`
 * shape the hook returns, so a sim module can build its own translator
 * straight from an imported JSON catalog while the hook below builds one from
 * whatever the locale context is currently holding. One resolution algorithm,
 * two ways to reach it.
 */

/** A message catalog namespace: arbitrarily nested strings and string arrays. */
export type MessageNode = string | string[] | { [key: string]: MessageNode };
export type Messages = Record<string, MessageNode>;

export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Resolve a dot-separated path (`'nav.links.howItWorks'`) against a nested message tree. */
function resolvePath(node: MessageNode | undefined, path: string[]): MessageNode | undefined {
  let current: MessageNode | undefined = node;
  for (const segment of path) {
    if (typeof current !== 'object' || Array.isArray(current) || current === null) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function interpolate(value: string, params?: Record<string, string | number>): string {
  if (!params) return value;
  return value.replace(/{(\w+)}/g, (match, paramKey) => {
    const paramValue = params[paramKey];
    return paramValue !== undefined ? String(paramValue) : match;
  });
}

/** A translator bound to one namespace's message tree — the key lookup with no React underneath it. */
export function createTranslator(domainMessages: MessageNode | undefined): Translate {
  return (key, params) => {
    const value = resolvePath(domainMessages, key.split('.'));
    if (typeof value !== 'string') return key;
    return interpolate(value, params);
  };
}
