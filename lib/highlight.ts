/**
 * A deliberately small syntax highlighter.
 *
 * The site shows four languages in short, hand-picked snippets. Pulling in
 * Prism or Shiki to colour ~60 lines of PHP would cost more bytes than the
 * rest of the page, so this is a single-pass tokenizer instead: one
 * alternation per language, first rule wins, anything unmatched falls
 * through as plain text.
 *
 * Rule sources must contain NO capturing groups — the scanner maps match
 * groups to rule names positionally.
 */

export type Lang = 'php' | 'json' | 'sql' | 'bash';
export type Token = { kind: string; text: string };

type Rule = [kind: string, source: string];

const RULES: Record<Lang, Rule[]> = {
  php: [
    ['comment', String.raw`\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/`],
    ['string', String.raw`'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"`],
    ['var', String.raw`\$[A-Za-z_]\w*`],
    ['arg', String.raw`[A-Za-z_]\w*(?=\s*:(?!:))`],
    [
      'keyword',
      String.raw`\b(?:new|use|function|fn|return|foreach|as|echo|class|final|readonly|public|private|match|throw|try|catch|null|true|false|declare|strict_types)\b`,
    ],
    ['type', String.raw`\b[A-Z]\w*\b`],
    ['number', String.raw`\b\d+(?:\.\d+)?\b`],
    ['fn', String.raw`\b[a-z_]\w*(?=\s*\()`],
    ['punct', String.raw`[=>{}()\[\];,.:|?!<>+\-*\/]`],
  ],
  json: [
    ['key', String.raw`"(?:\\.|[^"\\])*"(?=\s*:)`],
    ['string', String.raw`"(?:\\.|[^"\\])*"`],
    ['keyword', String.raw`\b(?:true|false|null)\b`],
    ['number', String.raw`-?\b\d+(?:\.\d+)?\b`],
    ['punct', String.raw`[{}\[\]:,]`],
  ],
  sql: [
    ['comment', String.raw`--[^\n]*`],
    ['string', String.raw`'(?:''|[^'])*'`],
    [
      'keyword',
      String.raw`\b(?:SELECT|FROM|WHERE|JOIN|LEFT|INNER|OUTER|ON|AND|OR|NOT|IN|IS|NULL|ORDER|GROUP|BY|LIMIT|OFFSET|AS|INSERT|INTO|VALUES|UPDATE|SET|DELETE|EXISTS|DISTINCT|USING|ASC|DESC)\b`,
    ],
    ['fn', String.raw`\b[A-Z_]{2,}(?=\s*\()`],
    ['number', String.raw`\b\d+(?:\.\d+)?\b`],
    ['punct', String.raw`[=<>!*(),.;]`],
  ],
  bash: [
    ['comment', String.raw`#[^\n]*`],
    ['string', String.raw`'(?:[^'])*'|"(?:\\.|[^"\\])*"`],
    ['flag', String.raw`(?:^|\s)--?[A-Za-z][\w-]*`],
    ['fn', String.raw`^\s*[a-z][\w\/.-]*`],
  ],
};

const cache = new Map<Lang, RegExp>();

function scanner(lang: Lang): RegExp {
  let re = cache.get(lang);
  if (!re) {
    re = new RegExp(RULES[lang].map(([, src]) => `(${src})`).join('|'), 'gm');
    cache.set(lang, re);
  }
  return re;
}

export function tokenize(code: string, lang: Lang): Token[] {
  const rules = RULES[lang];
  const re = scanner(lang);
  const out: Token[] = [];
  let last = 0;

  re.lastIndex = 0;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    if (m.index > last) out.push({ kind: 'plain', text: code.slice(last, m.index) });

    // Group i + 1 corresponds to rules[i]; exactly one is defined.
    let kind = 'plain';
    for (let i = 0; i < rules.length; i++) {
      if (m[i + 1] !== undefined) {
        kind = rules[i][0];
        break;
      }
    }
    out.push({ kind, text: m[0] });
    last = m.index + m[0].length;

    // Zero-length matches would spin forever.
    if (m[0].length === 0) re.lastIndex++;
  }

  if (last < code.length) out.push({ kind: 'plain', text: code.slice(last) });
  return out;
}
