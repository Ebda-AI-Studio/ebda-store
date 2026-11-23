/**
 * QA-71: /ar/terms, /ar/privacy, /ar/legal (and every other /ar/<page>) are ONE redirect hop to the slashed page.
 * The `/ar/*` splat targets a slash-less path that the edge slashes again (2 hops), so each page has its own rule.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const rules = readFileSync(join(__dirname, '../../apps/marketing/public/_redirects'), 'utf8')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'))
  .map(l => l.split(/\s+/));
const hop = (path: string) => {
  for (const [from, to, status] of rules) {
    if (from === path) return { to, status: Number(status) };
    if (from.endsWith('/*') && path.startsWith(from.slice(0, -1)))
      return { to: to.replace(':splat', path.slice(from.length - 1)), status: Number(status) };
  }
  return null;
};

describe('marketing /ar legal links', () => {
  for (const p of ['legal', 'privacy', 'terms', 'refund']) {
    it(`/ar/${p} and /ar/${p}/ land on /${p}/ in one 308`, () => {
      for (const src of [`/ar/${p}`, `/ar/${p}/`]) {
        const r = hop(src)!;
        expect(r.to).toBe(`/${p}/`);
        expect(r.status).toBe(308);
        // the target is final: no rule matches the slashed page
        expect(rules.some(([from]) => from === r.to)).toBe(false);
      }
    });
  }
});
