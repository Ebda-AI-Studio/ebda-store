/**
 * Regression for #1216 / #1333: bulk-ai-seo.ts writes prisma.store.update
 * ({ metaTitle, metaDescription, ... }), and bulk-ai-aeo.ts / bulk-ai-geo.ts
 * write store.llmsTxt / store.aboutJson / storeFaq / storeHowto directly —
 * but all 7 "sweep complete" cache-bust call sites across the three files
 * only ever called invalidateStoreProductCaches (product/category caches),
 * never bustStoreCaches (the store RECORD's own public:store:<id> cache).
 * The storefront kept serving pre-sweep store data (SEO meta, llms.txt,
 * about page, FAQ/HowTo) until that key's TTL expired.
 *
 * After main's #1333 (bustStoreCachesById, store-only sweeps no longer bust
 * product caches), the per-function product/store split for aeo + geo is
 * pinned by bulk-ai-store-cache-bust.test.ts; this file pins that EVERY
 * sweep function busts the store record, by id (slug + domain keys too — a
 * `bustStoreCaches(storeId, null)` left `public:store:<slug>` stale).
 *
 * Asserts on source text: these are large Inngest step functions with
 * Gemini calls and DB writes throughout — a full render/execution test of
 * all 7 call sites is disproportionate to a "was the sibling fix applied
 * everywhere" check, which the source itself answers directly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FUNCTIONS_DIR = join(__dirname, '../../apps/api/src/lib/inngest/functions');

function countOccurrences(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

describe('bulk AI sweeps bust the store record cache too (#1216, #1333)', () => {
  function counts(file: string) {
    const source = readFileSync(join(FUNCTIONS_DIR, file), 'utf-8');
    return {
      source,
      functions: countOccurrences(source, /inngest\.createFunction\(/g),
      productBusts: countOccurrences(source, /step\.run\('bust-product-caches'/g),
      storeBusts: countOccurrences(source, /step\.run\('bust-store-caches?'/g),
      byId: countOccurrences(source, /bustStoreCachesById\(storeId\)/g),
    };
  }

  it('bulk-ai-seo.ts: its product bust is paired with a by-id store bust', () => {
    const c = counts('bulk-ai-seo.ts');
    expect(c.productBusts).toBeGreaterThan(0);
    expect(c.storeBusts).toBe(c.productBusts);
    expect(c.byId).toBe(c.storeBusts);
    expect(c.source).not.toMatch(/bustStoreCaches\(storeId, null\)/);
  });

  for (const file of ['bulk-ai-aeo.ts', 'bulk-ai-geo.ts']) {
    it(`${file}: every one of its three sweeps busts the store record by id`, () => {
      const c = counts(file);
      expect(c.functions).toBe(3);
      expect(c.storeBusts).toBe(3);
      expect(c.byId).toBe(3);
      expect(c.source).not.toMatch(/bustStoreCaches\(storeId, null\)/);
    });
  }
});
