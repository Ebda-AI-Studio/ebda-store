/**
 * Verification wave 3 (D5): `t('key').replace('{var}', v)` never works with next-intl. The message
 * has a `{var}` argument, so `t('key')` with no values logs an IntlError FORMATTING_ERROR (the
 * admin products list logged it for `{storeName}` and `{count}`) and returns the fallback, and the
 * later `.replace` has nothing to replace. Pass the values: `t('key', { var: v })`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../apps/admin/src');

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules') yield* sources(p);
    } else if (/\.(tsx?)$/.test(p) && !/\.test\./.test(p)) yield p;
  }
}

describe('admin i18n placeholders', () => {
  it("no <translator>('key').replace('{var}', ...) in the admin app", () => {
    const offenders: string[] = [];
    for (const file of sources(ROOT)) {
      const src = readFileSync(file, 'utf8');
      // ANY translator name (t, tFields, tc, tCommon, ...), with or without a values arg:
      // the callee is an identifier called with a string key, then `.replace('{var}'`.
      for (const m of src.matchAll(
        /\b\w+\(\s*['"][\w.]+['"]\s*(?:,[^()]*)?\)\s*\.replace\(\s*['"]\{\w+\}['"]/g
      )) {
        offenders.push(`${path.relative(ROOT, file)}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
