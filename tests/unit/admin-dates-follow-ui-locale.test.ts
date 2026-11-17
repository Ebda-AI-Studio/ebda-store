/**
 * K1: `toLocaleDateString(undefined, ...)` formats in the BROWSER's language, so an Arabic admin on an English
 * browser read "November 15, 2026" on /account/security. Every admin date/time uses `intlLocaleForUi()`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(n) && !/\.test\./.test(n)) out.push(p);
  }
  return out;
}

describe('admin dates follow the UI language', () => {
  it('no toLocale{Date,Time,}String call leaves the locale undefined or hard-coded English', () => {
    const bad = walk('apps/admin/src').filter(f =>
      /toLocale(Date|Time)?String\(\s*(undefined|'en[^']*'|"en[^"]*"|\))/.test(
        readFileSync(f, 'utf8')
      )
    );
    // Whole-number formatting with a pinned 'en'/'en-US' is a Latin-digit choice, not a date (billing, pulse).
    const dateOffenders = bad.filter(f =>
      /toLocale(Date|Time)String\(\s*(undefined|'en[^']*'|"en[^"]*"|\))|new Date\([^)]*\)\.toLocaleString\(\s*(undefined|'en)/.test(
        readFileSync(f, 'utf8')
      )
    );
    expect(dateOffenders).toEqual([]);
  });
});
