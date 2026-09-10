'use client';

import { createContext, useContext } from 'react';
import type { Locale } from './types';

/** A message catalog namespace: arbitrarily nested strings and string arrays. */
export type MessageNode = string | string[] | { [key: string]: MessageNode };
export type Messages = Record<string, MessageNode>;

interface LocaleContextValue {
  locale: Locale;
  messages: Messages;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: Messages;
  children: React.ReactNode;
}) {
  return (
    <LocaleContext.Provider value={{ locale, messages }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale(): Locale {
  const context = useContext(LocaleContext);
  if (!context) {
    return 'en';
  }
  return context.locale;
}

export function useMessages(): Messages {
  const context = useContext(LocaleContext);
  if (!context) {
    return {};
  }
  return context.messages;
}

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

export function useTranslations(namespace: string) {
  const messages = useMessages();
  const domainMessages = messages[namespace];

  return (key: string, params?: Record<string, string | number>): string => {
    const value = resolvePath(domainMessages, key.split('.'));

    if (typeof value !== 'string') {
      return key;
    }

    if (params) {
      return value.replace(/{(\w+)}/g, (match, paramKey) => {
        const paramValue = params[paramKey];
        return paramValue !== undefined ? String(paramValue) : match;
      });
    }

    return value;
  };
}
