/**
 * Hold every foreground token to WCAG AA against every surface it actually
 * renders on.
 *
 * Nothing else here catches this. A typecheck sees a CSS custom property and
 * is satisfied by any six-digit string; a build sees a stylesheet. The
 * failure this exists to catch is a token that reads as "dim enough" by eye —
 * `--text-faint` shipped at 3.38:1 against `--panel-2` for the whole of
 * stages 0–7, under a value nobody had measured, carrying real content: every
 * `TableView` column header, the event-log gutter, every truncation note, and
 * the empty-table explanations several sections exist to make readable.
 *
 * Uniformly 4.5:1 (the AA "normal text" floor) rather than the "large text"
 * 3:1 floor some headings could claim — every use on this site is 11–17px
 * mono or sans, never bold at 18.5px+, so the stricter number is also the
 * honest one. Being uniformly strict is simpler than being exactly right
 * about which span is which size, on the same rule `execute.ts` follows for
 * case-insensitive string comparison: approximately right beats exactly
 * wrong.
 *
 * Foregrounds and surfaces are read out of `app/globals.css`'s `:root` block
 * rather than duplicated here, so a palette change is caught without this
 * file needing to change too — only the *pairing* below is this script's
 * opinion.
 *
 * Run with `npm run verify:contrast`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let failed = false;

function fail(message: string): void {
  failed = true;
  console.error(message);
}

function pass(message: string): void {
  console.log(`  ${message}`);
}

/** Every `--token: #rrggbb;` declared inside `:root { ... }`. */
function readTokens(css: string): Map<string, string> {
  const root = css.match(/:root\s*{([\s\S]*?)\n}/);
  if (!root) throw new Error('no :root block found in globals.css');
  const tokens = new Map<string, string>();
  for (const m of root[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens.set(m[1], m[2]);
  }
  return tokens;
}

/** Relative luminance, per the WCAG 2 formula. */
function luminance(hex: string): number {
  const c = [1, 3, 5].map(i => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrastRatio(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const AA_NORMAL = 4.5;

// __dirname is `.scenario-build/scripts` (see tsconfig.scripts.json), two
// levels below the project root the other verify scripts are run from.
const css = readFileSync(join(__dirname, '..', '..', 'app', 'globals.css'), 'utf8');
const tokens = readTokens(css);

function tok(name: string): string {
  const v = tokens.get(name);
  if (!v) throw new Error(`token --${name} not found in globals.css`);
  return v;
}

/**
 * Every surface a panel or the page background can actually be — not `--well`
 * alone or `--bg` alone, because text sits on all five depending on which
 * component it is in (a table body is `--well`, a card head is `--panel`, a
 * nested control is `--panel-2`).
 */
const SURFACES = ['bg', 'bg-raised', 'panel', 'panel-2', 'well'];

/**
 * Every foreground token that is rendered as text somewhere on the site,
 * against every surface above. `--border-hover` and the `-soft`/`-rgb`
 * companions are deliberately excluded — they are borders and fills, never
 * text colour.
 */
const FOREGROUNDS = ['text', 'text-dim', 'text-faint', 'accent', 'indexed', 'pending', 'danger'];

console.log('contrast (AA normal text, 4.5:1)');

for (const fg of FOREGROUNDS) {
  for (const bg of SURFACES) {
    const ratio = contrastRatio(tok(fg), tok(bg));
    const label = `--${fg} on --${bg} (${ratio.toFixed(2)}:1)`;
    if (ratio < AA_NORMAL) {
      fail(`✗ ${label} — below ${AA_NORMAL}:1`);
    } else {
      pass(`✓ ${label}`);
    }
  }
}

console.log(failed ? '\nFAILED' : '\nall contrast checks green');
process.exit(failed ? 1 : 0);
