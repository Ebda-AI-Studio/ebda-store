/**
 * SIGN-1 guard (ebda-foundation design/DESIGN.md; formatter: packages/shared/src/region/signed.ts).
 *
 * Fails when UI source (apps/{admin,web,orders} + packages/ui) builds a number's sign by hand:
 *   S1  a sign literal as an expression: '+' / '−' / '−' (ternary prefix before a number)
 *   S2  a sign glued onto a value: `+${n}` / `-${n}` in a template, or JSX text `+{n}` / `-{n}` / `−{n}`
 *   S3  a hyphen sign in a ternary: `? '-' :` / `: '-'`
 * Use formatSigned() / <SignedNumber> instead (zero prints plain, sign + number are one LTR isolate).
 * A line that is not a number may carry `sign-ok: <reason>` in a comment on that line or the line above.
 * The sanctioned JSX/string twins signedText() and <SignedAmount> are skipped.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');
const DIRS = ['apps/admin/src', 'apps/web/src', 'apps/orders/src', 'packages/ui/src'];

export const SIGN_RULES: Record<string, RegExp> = {
  S1: /(?:[?:(]|&&|\|\||=)\s*['"`](?:\+|−)['"`]/,
  S2: /(?:[`>]|\{\s*)[+−-]\$\{|(?:^|>|\s)[+−-]\{[A-Za-z(]/,
  S3: /[<>]=?\s*0\s*\?\s*['"`]-['"`]/,
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (statSync(p).isDirectory())
      return n === 'node_modules' || n === '__tests__' || n === '.next' ? [] : walk(p);
    return /\.tsx$/.test(n) && !/\.(test|spec)\./.test(n) ? [p] : [];
  });
}

export function signViolations(src: string): { line: number; rule: string; text: string }[] {
  const out: { line: number; rule: string; text: string }[] = [];
  const lines = src.split('\n');
  lines.forEach((text, i) => {
    if (/sign-ok:/.test(text) || /sign-ok:/.test(lines[i - 1] ?? '')) return;
    if (/^\s*(\/\/|\*|\/\*)/.test(text) || /signedText\(|<SignedAmount\b/.test(text)) return;
    for (const [rule, re] of Object.entries(SIGN_RULES)) {
      if (re.test(text)) {
        out.push({ line: i + 1, rule, text: text.trim() });
        break;
      }
    }
  });
  return out;
}

describe('SIGN-1: no hand-built sign prefixes in UI source', () => {
  it('finds none under apps/{admin,web,orders} + packages/ui', () => {
    const bad = DIRS.flatMap(d =>
      walk(join(ROOT, d)).flatMap(f =>
        signViolations(readFileSync(f, 'utf8')).map(
          v => `${relative(ROOT, f)}:${v.line} ${v.rule} ${v.text}`
        )
      )
    );
    expect(bad).toEqual([]);
  });

  it('the rules catch the shapes they exist for (negative control)', () => {
    const cases = [
      '{row.delta >= 0 ? `+${row.delta}` : row.delta}',
      "{entry.amount > 0 ? '+' : '−'}",
      '<span>-{member.totalRedeemed}</span>',
      '<dd>−{formatMoney(x)}</dd>',
      "{l.adjustment > 0 ? '-' : l.adjustment < 0 ? '+' : ''}",
      'return `-${pct.toFixed(1)}%`;',
    ];
    for (const c of cases) expect(signViolations(c), c).not.toEqual([]);
    const fine = [
      'const a = x - 1;',
      '<span className="mt-2 -ml-1">',
      "{txn.description || '-'}",
      '{formatSigned(v, { plus: true })}',
      'const s = `${a}-${b}`;',
    ];
    for (const c of fine) expect(signViolations(c), c).toEqual([]);
  });
});
