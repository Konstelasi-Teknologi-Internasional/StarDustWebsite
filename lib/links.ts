/**
 * Every outbound URL, in one plain module.
 *
 * Deliberately NOT in a component file. These are imported by both server
 * and client components, and a constant exported from a `'use client'`
 * module reaches the server as a client-reference stub — bare `href={REPO}`
 * survives that, but `${REPO}/issues` stringifies the stub's source into the
 * href and ships a broken link. Keeping them here removes the hazard.
 *
 * Casing matters: GitHub redirects the wrong case, but the canonical repo is
 * `damarbob/StarDust`. Packagist names are lowercase by spec.
 */
export const REPO = 'https://github.com/damarbob/StarDust';

export const DOCS = `${REPO}#readme`;
export const CHANGELOG = `${REPO}/blob/main/CHANGELOG.md`;
export const CONTRIBUTING = `${REPO}/blob/main/CONTRIBUTING.md`;
export const TESTING = `${REPO}/blob/main/TESTING.md`;
export const EXAMPLES = `${REPO}/tree/main/examples`;
export const ISSUES = `${REPO}/issues`;

export const PACKAGIST = 'https://packagist.org/packages/damarbob/stardust';
export const SITE_REPO =
  'https://github.com/Konstelasi-Teknologi-Internasional/StarDustWebsite';
