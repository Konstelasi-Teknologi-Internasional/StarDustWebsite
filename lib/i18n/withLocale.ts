import type { Locale } from './types';
import { defaultLocale } from './types';

/**
 * Convert a root-relative path to a locale-prefixed path.
 * English (default locale) stays unprefixed.
 * Indonesian paths get /id/ prefix.
 *
 * @example
 * withLocale('en', '/playground/') // '/playground/'
 * withLocale('id', '/playground/') // '/id/playground/'
 */
export function withLocale(locale: Locale, path: string): string {
  if (locale === defaultLocale) {
    return path;
  }
  return `/${locale}${path}`;
}
