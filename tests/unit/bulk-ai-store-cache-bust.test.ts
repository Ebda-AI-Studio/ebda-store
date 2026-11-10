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
import ts from 'typescript';
import {
  callEnclosingProperty,
  callsTo,
  code,
  findFunction,
  nodesOf,
  parseFile,
} from './helpers/ast-query';
import { join } from 'node:path';

const AEO_PATH = join(__dirname, '../../apps/api/src/lib/inngest/functions/bulk-ai-aeo.ts');
const GEO_PATH = join(__dirname, '../../apps/api/src/lib/inngest/functions/bulk-ai-geo.ts');

/**
 * The Inngest function declared with `id: '<functionId>'`: the whole `inngest.createFunction(...)` call that
 * carries that id (AST, so a comment mentioning a call, or the neighbouring function, can never satisfy it).
 */
function fn(sf: ts.SourceFile, functionId: string): ts.CallExpression {
  return callEnclosingProperty(sf, 'id', functionId);
}
const busts = (call: ts.Node, callee: string) =>
  callsTo(call, callee).filter(c => code(c.arguments[0]) === 'storeId');

describe('bulk-ai-aeo.ts store-record sweeps bust the STORE cache, not the product cache', () => {
  const source = parseFile(AEO_PATH);

  it('bulk-ai-faq-aeo (writes StoreFaq only)', () => {
    const body = fn(source, 'bulk-ai-faq-aeo');
    expect(busts(body, 'bustStoreCachesById')).toHaveLength(1);
    expect(busts(body, 'invalidateStoreProductCaches')).toHaveLength(0);
  });

  it('bulk-ai-howto-aeo (writes StoreHowto only)', () => {
    const body = fn(source, 'bulk-ai-howto-aeo');
    expect(busts(body, 'bustStoreCachesById')).toHaveLength(1);
    expect(busts(body, 'invalidateStoreProductCaches')).toHaveLength(0);
  });

  it('bulk-ai-meta-aeo (writes products/categories AND Store.metaDescriptionAeo — needs both)', () => {
    const body = fn(source, 'bulk-ai-meta-aeo');
    expect(busts(body, 'bustStoreCachesById')).toHaveLength(1);
    expect(busts(body, 'invalidateStoreProductCaches')).toHaveLength(1);
  });
});

describe('bulk-ai-geo.ts store-record sweeps bust the STORE cache, not the product cache', () => {
  const source = parseFile(GEO_PATH);

  it('bulk-ai-llms-txt (writes Store.llmsTxt only)', () => {
    const body = fn(source, 'bulk-ai-llms-txt');
    expect(busts(body, 'bustStoreCachesById')).toHaveLength(1);
    expect(busts(body, 'invalidateStoreProductCaches')).toHaveLength(0);
  });

  it('bulk-ai-brand-facts (writes Store.aboutJson only)', () => {
    const body = fn(source, 'bulk-ai-brand-facts');
    expect(busts(body, 'bustStoreCachesById')).toHaveLength(1);
    expect(busts(body, 'invalidateStoreProductCaches')).toHaveLength(0);
  });

  it('citation-copy (writes prisma.product.update — the one GEO sweep that was already correct)', () => {
    const body = fn(source, 'bulk-ai-citation-copy');
    expect(busts(body, 'invalidateStoreProductCaches')).toHaveLength(1);
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
    const sf = parseFile(join(__dirname, '../../apps/web/src/app/llms.txt/route.ts'));
    const body = findFunction(sf, 'fetchStore');
    const tags = nodesOf(body)
      .filter(
        (n): n is ts.PropertyAssignment =>
          ts.isPropertyAssignment(n) &&
          code(n.name) === 'tags' &&
          ts.isArrayLiteralExpression(n.initializer)
      )
      .map(n => code(n.initializer));
    expect(tags).toContain('[`store-slug:${slug}`]');
  });
});
