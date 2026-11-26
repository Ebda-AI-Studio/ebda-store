/**
 * STORE-QA-10 guard: admin components render money and dates through ONE formatter each
 * (`formatPrice` / `formatDate` in apps/admin/src/lib/format.ts), which follow the UI language.
 * Fails on: a hard-coded "EGP" money template, a bare decimal glued to a separate currency label, formatMoney pinned to 'en',
 * and a date rendered in the browser's own locale (no year, wrong language for an Arabic admin).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../apps/admin/src');
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n === 'node_modules' || n === '__tests__') continue;
      walk(p, out);
    } else if (/\.(tsx?)$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

const RULES: Array<[string, RegExp]> = [
  ['hard-coded EGP money template', /`[^`]*\bEGP\s*\$\{|\$\{[^}]*\}\s*EGP\b[^`]*`/],
  [
    'decimal helper glued to a separate currency label',
    /\{(?:major|minorToMajor)\([^{}]*\)\}\s*\{tc?\('egp'\)\}|\{tc?\('egp'\)\}\s*\{(?:major|minorToMajor)\(/,
  ],
  ['formatMoney pinned to a locale', /formatMoney\([^)]*,\s*'en'/],
  ['date in the browser locale', /toLocaleDateString\(\s*(?:undefined|'en)/],
];

describe('admin: one money format and one date format', () => {
  const files = walk(ROOT);
  for (const [name, re] of RULES) {
    it(`no ${name}`, () => {
      const hits = files
        .filter(f => re.test(readFileSync(f, 'utf8')))
        .map(f => f.replace(ROOT, ''));
      expect(hits).toEqual([]);
    });
  }
});
