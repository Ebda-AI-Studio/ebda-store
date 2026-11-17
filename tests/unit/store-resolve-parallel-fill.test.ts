/**
 * RESOLVE-PARALLEL-1: the public store payload (`GET /public/store/resolve` and `GET /public/stores/:slugOrId`) is filled by
 * independent Durable Object / D1 reads that depend only on the store row. They used to be awaited one after another, so a
 * cache miss cost the SUM of them (4-8 s measured on 2026-11-15, p90 5.1 s / max 8.2 s for `/store/resolve`, which the
 * storefront page waits on before its own calls and which the 8 s status probe read as "no response"). A sequential
 * `await` of any of them in the route brings that back, so this scan fails on it.
 *
 * Structural, not a timing test: the route file is too large to mount here. It pins the shape that removes the sum.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = readFileSync(
  path.resolve(__dirname, '../../apps/api/src/routes/public.routes.ts'),
  'utf8'
);

const FILL_READS = [
  'resolveActiveTaxRate',
  'isSmsMarketingAvailable',
  'cartEmailOptInAvailable',
  'whatsappOptInAvailable',
  'fetchFooterLocations',
  'featureService.getEnabledFeatureKeys',
];

describe('public store payload fill is concurrent (RESOLVE-PARALLEL-1)', () => {
  it('no fill read is awaited on its own (outside Promise.all) in the route file', () => {
    for (const fn of FILL_READS) {
      const lines = SRC.split('\n')
        .map((l, i) => ({ l, n: i + 1 }))
        // `async function name(` declarations are not call sites
        .filter(x => x.l.includes(`await ${fn}(`) && !/^\s*(export\s+)?async function/.test(x.l));
      expect(
        lines.map(x => `public.routes.ts:${x.n}: ${x.l.trim()}`),
        `${fn} must run inside Promise.all, not as its own await`
      ).toEqual([]);
    }
  });

  it('both fills use one Promise.all over the independent reads', () => {
    const fills = SRC.split('RESOLVE-PARALLEL-1').length - 1;
    expect(fills).toBeGreaterThanOrEqual(2);
    for (const fn of FILL_READS) {
      const name = fn.split('.').pop() as string;
      const hits = SRC.split('\n').filter(l => new RegExp(`^\\s+(\\w+\\.)?${name}\\(`).test(l));
      expect(
        hits.length,
        `${fn} appears as a Promise.all member in both fills`
      ).toBeGreaterThanOrEqual(2);
    }
  });
});
