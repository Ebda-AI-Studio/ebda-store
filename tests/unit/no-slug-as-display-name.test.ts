/**
 * STOP-2 (taste audit): a store's slug leaked into a hero as if it were the store's name. The
 * slug is an address, never a label: no storefront or API code may fall back to it for a
 * visible name, and the scenario seeds never name a store after its slug.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap(n => {
    const f = path.join(d, n);
    if (/node_modules|\.next|__tests__/.test(f)) return [];
    return statSync(f).isDirectory()
      ? walk(f)
      : /\.(tsx?|mjs)$/.test(n) && !/\.test\./.test(n)
        ? [f]
        : [];
  });

// `name || slug`, `name ?? slug`, `slug || name`: a visible name that falls back to the slug.
const FALLBACK =
  /\b(?:name|Name|nameAr|title)\s*(?:\|\||\?\?)\s*[\w.?]*slug\b|\bslug\s*(?:\|\||\?\?)\s*[\w.?]*(?:name|Name)\b/;
// Filenames and catalogue labels sent to a third party are not storefront display: allow-listed with why.
const ALLOWED: Record<string, string> = {
  'apps/api/src/routes/customers.routes.ts': 'export filename',
  'apps/api/src/routes/order.routes.ts': 'export filename',
  'apps/api/src/routes/wbs-integration.routes.ts': 'WhatsApp catalog label, brand name first',
};

describe('no slug as a display name', () => {
  for (const dir of ['apps/web/src', 'apps/api/src']) {
    it(`${dir} never falls back from a name to a slug`, () => {
      const hits: string[] = [];
      for (const f of walk(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, f);
        if (ALLOWED[rel]) continue;
        readFileSync(f, 'utf8')
          .split('\n')
          .forEach((l, i) => {
            if (FALLBACK.test(l) && !/slugify|baseSlug|data\.slug|^\s*slug:/.test(l))
              hits.push(`${rel}:${i + 1}: ${l.trim()}`);
          });
      }
      expect(hits).toEqual([]);
    });
  }
  it('the negative control: the pattern flags the leak it exists for', () => {
    expect(FALLBACK.test('const n = store.name || store.slug;')).toBe(true);
    expect(FALLBACK.test('const n = store.slug ?? store.name;')).toBe(true);
    expect(FALLBACK.test('const n = store.name || store.nameAr;')).toBe(false);
  });
  it('the scenario seed names stores by role, never by slug', () => {
    const s = readFileSync(path.join(ROOT, 'scripts/storedemo/scenario-stores.mjs'), 'utf8');
    expect(s).not.toMatch(/name:\s*`[^`]*\$\{slug\}/);
    expect(s).not.toMatch(/nameAr:\s*`[^`]*\$\{slug\}/);
  });
});
