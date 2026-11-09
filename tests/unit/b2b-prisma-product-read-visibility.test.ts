/**
 * Prisma-read visibility (review C1). The raw-SQL scan cannot see Prisma reads, and the leak it missed was a Prisma relation
 * read: recommendations hydrated `targetProduct` / `product1` / `product2` with no audience filter. This scan lists every
 * Prisma read of the product model, and every read that hydrates a product through a recommendation-shaped relation, in the
 * storefront-facing files, and requires the audience filter (`audience` / `visibleProductWhere`) in the read itself, or an
 * allowlisted entry with a reason. The allowlist is an exact count per file and kind: a NEW unfiltered read in any of these
 * files turns the test red until it is filtered or deliberately classified.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scanPrismaProductReads } from '../helpers/prisma-product-read-scan';

const API_SRC = resolve(__dirname, '../../apps/api/src');

/** Every file that serves (or feeds) an anonymous or buyer-facing product surface. */
const STOREFRONT_FILES = [
  'services/recommendation.service.ts',
  'services/bundle.service.ts',
  'services/cart.service.ts',
  'services/order.service.ts',
  'services/product.service.ts',
  'services/product-search.service.ts',
  'services/review.service.ts',
  'services/abandoned-cart.service.ts',
  'routes/public.routes.ts',
  'routes/wishlist.routes.ts',
  'routes/wholesale.routes.ts',
  // product names leave the platform as answer-engine prompts (ChatGPT / Perplexity citation scan): final review minor 1
  'services/answer-engine/prompts.ts',
];

/** `file :: kind` -> how many reads in that file may lack the filter, and why that is safe. */
const ALLOW: Record<string, { count: number; reason: string }> = {
  'services/recommendation.service.ts :: productRelation.findMany->targetProduct': {
    count: 1,
    reason:
      'getRelations: the merchant relation editor (authenticated admin route), must list every target',
  },
  'services/cart.service.ts :: product.findFirst': {
    count: 1,
    reason:
      'addItem: reads the product with its audience and 404s a wholesale-only one for a non-member right after (canSeeWholesaleOnly)',
  },
  'routes/public.routes.ts :: product.findUnique': {
    count: 1,
    reason:
      'review form for an order the signed token proves the shopper placed: they already bought it',
  },
  'services/review.service.ts :: product.findFirst': {
    count: 1,
    reason:
      'create: an authenticated review of a product the shopper bought (purchase check follows)',
  },
  'services/order.service.ts :: product.findUnique': {
    count: 2,
    reason:
      'inventory flag / stock reads by id inside an already-priced, already-gated order (create gate: wholesale-only line refused 409)',
  },
  'services/order.service.ts :: product.findMany': {
    count: 2,
    reason:
      'merchant manual order (authenticated admin surface): the merchant may sell wholesale-only products; createOnDo: lead time (leadTimeDays only) of the ids of cart lines the create gate already refused if wholesale-only (Ruling CF-FINAL-1)',
  },
  'services/product.service.ts :: product.findMany': {
    count: 8,
    reason:
      "list + bulkUpdate (merchant) and listPublic x4 + advancedSearch (storefront: their `where` is built with audience, covered by b2b-storefront-visibility). The hybrid-ranked listPublic path adds two: an id-only read with the audited `where` (audience included) and the page read by ids that read already filtered, so a wholesale-only id can never reach it. onSaleIdsFromDo (the DO twin of the sort=on_sale statement, P1 2026-11-09) adds one whose `where` carries `audience: 'public'` literally",
  },
  'services/product.service.ts :: product.count': {
    count: 4,
    reason: 'the counts paired with the four findMany reads above (same `where`)',
  },
  'services/product.service.ts :: product.findFirst': {
    count: 6,
    reason:
      'getById / getBySlug / create / update: merchant surface; plus the two reads in readPublicDetail, whose `where` is built by getPublicBySlug / getPublicById WITH the audience filter',
  },
};

function unfilteredByKey() {
  const out = new Map<string, number>();
  for (const f of STOREFRONT_FILES) {
    for (const r of scanPrismaProductReads(f, readFileSync(resolve(API_SRC, f), 'utf8'))) {
      if (r.hasAudience) continue;
      const key = `${f} :: ${r.kind}`;
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  }
  return out;
}

describe('Prisma product reads on storefront paths carry the audience filter', () => {
  it('every unfiltered read is classified, with an exact count', () => {
    const found = unfilteredByKey();
    const problems: string[] = [];
    for (const [key, n] of found) {
      const a = ALLOW[key];
      if (!a)
        problems.push(
          `UNFILTERED ${key} x${n} (add the audience filter, or classify it with a reason)`
        );
      else if (a.count !== n) problems.push(`COUNT ${key}: expected ${a.count}, found ${n}`);
    }
    for (const key of Object.keys(ALLOW)) {
      if (!found.has(key)) problems.push(`STALE allowlist entry ${key}`);
    }
    expect(problems).toEqual([]);
  });

  it('every recommendation read hydrates only visible products (the C1 sites)', () => {
    const text = readFileSync(resolve(API_SRC, 'services/recommendation.service.ts'), 'utf8');
    const reads = scanPrismaProductReads('services/recommendation.service.ts', text);
    const hydrating = reads.filter(r => r.kind.includes('->'));
    expect(hydrating.length).toBeGreaterThanOrEqual(7); // cross-sell, AI, FBT, upsell, getRelations + the two cart batch reads
    expect(hydrating.filter(r => !r.hasAudience).map(r => r.line)).toHaveLength(1); // getRelations only (allowlisted)
  });

  it('planted bypasses: the scan flags an unfiltered relation hydration and an unfiltered product read, and accepts the helper', () => {
    const bad = `async function f(prisma:any){ return prisma.productRelation.findMany({ where:{storeId}, select:{ targetProduct:{ select:{id:true} } } }); }`;
    const bad2 = `async function g(prisma:any){ return prisma.product.findMany({ where:{storeId} }); }`;
    const bad3 = `async function h(prisma:any){ return prisma.frequentlyBoughtTogether.findMany({ select:{ product1:true, product2:true } }); }`;
    const good = `async function f(prisma:any){ return prisma.productRelation.findMany({ where:{storeId, targetProduct: visibleProductWhere()}, select:{ targetProduct:{ select:{id:true} } } }); }`;
    const good2 = `async function g(prisma:any){ return prisma.product.findMany({ where:{storeId, audience:'public'} }); }`;
    expect(scanPrismaProductReads('x.ts', bad)[0]).toMatchObject({ hasAudience: false });
    expect(scanPrismaProductReads('x.ts', bad2)[0]).toMatchObject({ hasAudience: false });
    expect(scanPrismaProductReads('x.ts', bad3)[0]).toMatchObject({ hasAudience: false });
    expect(scanPrismaProductReads('x.ts', good)[0]).toMatchObject({ hasAudience: true });
    expect(scanPrismaProductReads('x.ts', good2)[0]).toMatchObject({ hasAudience: true });
  });
});
