import type { Locale } from './types';
import type { Messages } from './context';

const messageCache = new Map<Locale, Messages>();

export async function loadMessages(locale: Locale): Promise<Messages> {
  if (messageCache.has(locale)) {
    return messageCache.get(locale)!;
  }

  const messages: Messages = {};

  // Dynamically import all message files for the locale
  const domains = ['common', 'landing', 'metadata', 'playground', 'tour', 'notify', 'scenarios'];

  for (const domain of domains) {
    try {
      const mod = await import(`../../messages/${locale}/${domain}.json`);
      messages[domain] = mod.default || mod;
    } catch (error) {
      console.warn(`Failed to load messages/${locale}/${domain}.json`);
    }
  }

  messageCache.set(locale, messages);
  return messages;
}
