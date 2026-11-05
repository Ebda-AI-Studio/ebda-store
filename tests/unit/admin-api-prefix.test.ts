/**
 * UX:PL-1 / BE:F-1 - every admin API call that passes a path starting with "/" must start with "/api/v1".
 * email-queue, sms-queue and webhook-events called "/admin/..." (404 in production). Matches single quotes,
 * double quotes AND template literals (the audit's quote-based scan missed the backtick calls).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '../../apps/admin/src');
const CALL =
  /\bapi(?:Get|GetQuiet|GetPage|Post|Put|Patch|Delete|Request|Fetch)\s*(?:<[^()]*?>)?\s*\(\s*(['"`])(\/[^'"`]*)/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n === 'node_modules' || n === '__tests__') continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(n) && !/\.test\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

describe('admin api prefix', () => {
  it('every absolute-path api call starts with /api/v1', () => {
    const bad: string[] = [];
    for (const f of walk(SRC)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(CALL)) {
        if (!m[2].startsWith('/api/v1')) bad.push(`${relative(SRC, f)}: ${m[2]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the matcher catches single-quoted and template-literal calls', () => {
    const sample = "apiPost<X>('/admin/a', {}); apiGet(`/admin/b${q}`); apiGet('/api/v1/ok');";
    const hits = [...sample.matchAll(CALL)].map(m => m[2]);
    expect(hits).toEqual(['/admin/a', '/admin/b${q}', '/api/v1/ok']);
  });
});
