'use client';

import { createContext, useContext } from 'react';
import { createTranslator, type Messages } from './resolve';
import type { Locale } from './types';

export type { MessageNode, Messages } from './resolve';

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

export function useTranslations(namespace: string) {
  const messages = useMessages();
  return createTranslator(messages[namespace]);
}
