/**
 * Merchant-facing copy never carries ops instructions: no hosting provider, env var names or "redeploy" in the admin
 * message catalogues. Platform setup (push keys, provider credentials) is ours, never the merchant's task.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '../../apps/admin/src/i18n/messages');
const BAD = /railway|\bONESIGNAL_|\bVAPID_|env(ironment)? var|\.env\b|متغيرات البيئة|إعادة النشر/i;
// Platform-staff only screen (the fee-notice sender), not a merchant surface.
const STAFF_ONLY = new Set(['tooLate']);

function walk(node: unknown, path: string[], out: Array<[string, string]>) {
  if (typeof node === 'string') out.push([path.join('.'), node]);
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) walk(v, [...path, k], out);
}

describe('admin copy has no ops instructions', () => {
  for (const f of ['en.json', 'ar.json']) {
    it(f, () => {
      const rows: Array<[string, string]> = [];
      walk(JSON.parse(readFileSync(join(DIR, f), 'utf8')), [], rows);
      const hits = rows.filter(([k, v]) => !STAFF_ONLY.has(k.split('.').pop()!) && BAD.test(v));
      expect(hits).toEqual([]);
    });
  }
});
