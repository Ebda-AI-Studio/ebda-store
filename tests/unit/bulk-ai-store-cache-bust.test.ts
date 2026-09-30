/**
 * #1333 — four of the six bulk-AI AEO/GEO Inngest functions bust
 * `invalidateStoreProductCaches(storeId)` (the `public:products:*` prefix) on
 * completion, but write ONLY store-record fields (StoreFaq/StoreHowto rows,
 * `Store.llmsTxt`, `Store.aboutJson`) that are served off the `public:store:*`
 * keys `bustStoreCachesById` busts — a completely different cache namespace.
 * The other two (citation-copy, meta-aeo) write products/categories and
 * correctly call the product invalidator; meta-aeo ALSO writes
 * `Store.metaDescriptionAeo`/`metaDescriptionAeoAr` and needs both.
 *
 * Driving these Inngest functions end-to-end needs a full Gemini + Prisma +
 * Inngest-step mock rig; this asserts on the SOURCE instead (the same
 * approach `checkout-error-code-coverage.test.ts` and Ruling M3-4 use here
 * for the same reason), scoped per function by its declared Inngest `id` so
 * it survives line-number drift.
 *
 * Mutation-proof: reverting any one bust call back to
 * `invalidateStoreProductCaches` (the pre-fix shape) reddens that function's
 * assertion below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AEO_PATH = join(__dirname, '../../apps/api/src/lib/inngest/functions/bulk-ai-aeo.ts');
const GEO_PATH = join(__dirname, '../../apps/api/src/lib/inngest/functions/bulk-ai-geo.ts');

/** The body of the Inngest function declared with `id: '<functionId>'`, up to the next such declaration (or EOF). */
function functionBody(source: string, functionId: string): string {
  const marker = `id: '${functionId}'`;
  const start = source.indexOf(marker);
  expect(start, `could not find ${marker}`).toBeGreaterThanOrEqual(0);
  const nextMarker = source.indexOf("id: '", start + marker.length);
  return nextMarker === -1 ? source.slice(start) : source.slice(start, nextMarker);
}

describe('bulk-ai-aeo.ts store-record sweeps bust the STORE cache, not the product cache', () => {
  const source = readFileSync(AEO_PATH, 'utf8');

  it('bulk-ai-faq-aeo (writes StoreFaq only)', () => {
    const body = functionBody(source, 'bulk-ai-faq-aeo');
    expect(body).toContain('bustStoreCachesById(storeId)');
    expect(body).not.toContain('invalidateStoreProductCaches(storeId)');
  });

  it('bulk-ai-howto-aeo (writes StoreHowto only)', () => {
    const body = functionBody(source, 'bulk-ai-howto-aeo');
    expect(body).toContain('bustStoreCachesById(storeId)');
    expect(body).not.toContain('invalidateStoreProductCaches(storeId)');
  });

  it('bulk-ai-meta-aeo (writes products/categories AND Store.metaDescriptionAeo — needs both)', () => {
    const body = functionBody(source, 'bulk-ai-meta-aeo');
    expect(body).toContain('bustStoreCachesById(storeId)');
    expect(body).toContain('invalidateStoreProductCaches(storeId)');
  });
});

describe('bulk-ai-geo.ts store-record sweeps bust the STORE cache, not the product cache', () => {
  const source = readFileSync(GEO_PATH, 'utf8');

  it('bulk-ai-llms-txt (writes Store.llmsTxt only)', () => {
    const body = functionBody(source, 'bulk-ai-llms-txt');
    expect(body).toContain('bustStoreCachesById(storeId)');
    expect(body).not.toContain('invalidateStoreProductCaches(storeId)');
  });

  it('bulk-ai-brand-facts (writes Store.aboutJson only)', () => {
    const body = functionBody(source, 'bulk-ai-brand-facts');
    expect(body).toContain('bustStoreCachesById(storeId)');
    expect(body).not.toContain('invalidateStoreProductCaches(storeId)');
  });

  it('citation-copy (writes prisma.product.update — the one GEO sweep that was already correct)', () => {
    const body = functionBody(source, 'bulk-ai-citation-copy');
    expect(body).toContain('invalidateStoreProductCaches(storeId)');
  });
});

/**
 * issue 2199 — the sweeps above write llmsTxt/aboutJson/FAQs, which
 * `/llms.txt` serves. Its per-store fetch had `revalidate: 600` and NO tag, so
 * the purge `bustStoreCaches` sends (`store-slug:<slug>`) could never reach it.
 * Mutation-proof: removing the tag reddens this.
 */
describe('/llms.txt subscribes to the store purge tag (issue 2199)', () => {
  it('fetchStore tags its fetch store-slug:<slug>', () => {
    const src = readFileSync(join(__dirname, '../../apps/web/src/app/llms.txt/route.ts'), 'utf8');
    const start = src.indexOf('async function fetchStore(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toContain('tags: [`store-slug:${slug}`]');
  });
});
