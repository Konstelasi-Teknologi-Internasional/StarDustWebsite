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
/**
 * The site's own canonical origin, used for the canonical link and the Open
 * Graph tags. Those must be absolute, and a static export has no request to
 * derive a host from, so it is stated once here. It lives in this module
 * rather than in `app/layout.tsx` because Next validates that file's exports
 * and rejects extra ones.
 */
export const SITE_URL = 'https://stardust.konstelasi.co.id';

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
