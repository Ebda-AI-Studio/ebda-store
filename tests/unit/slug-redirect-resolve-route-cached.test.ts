/**
 * #904 — `GET /public/redirects/resolve` sits on every storefront 404, which is what crawlers hit in
 * volume, so the route must answer through `resolveSlugRedirectCached`, never the raw chain walk.
 * (The cache itself: slug-redirect-resolve-cache.test.ts.)
 *
 * Behaviour, not source text: the REAL route handler runs (supertest) over a faked service pair; the
 * cached resolver must be asked, the raw one never. Harness: guest-order-route-token.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { getById, loggerCalls, setEdgeCacheMock, listPublic, suggest } = vi.hoisted(() => ({
  getById: vi.fn(),
  loggerCalls: [] as unknown[][],
  setEdgeCacheMock: vi.fn(),
  listPublic: vi.fn(),
  suggest: vi.fn(),
}));
const h = vi.hoisted(() => ({ cached: vi.fn(), raw: vi.fn() }));

vi.mock('@ebda/database', () => ({
  prisma: {},
  SlugEntityType: { PRODUCT: 'PRODUCT', BLOG: 'BLOG', CATEGORY: 'CATEGORY', PAGE: 'PAGE' },
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: (_id: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/config', () => ({
  config: { webUrl: 'https://ebda.app', apiUrl: 'https://api.ebda.app' },
}));
vi.mock('@api/lib/product-feed', () => ({ buildProductFeed: vi.fn() }));
vi.mock('@api/lib/public-cache', () => ({
  getCached: (_key: string, _ttl: number, fn: () => unknown) => fn(),
  boundedCacheKey: (p: string, k: string) => p + k,
  invalidateCachedPrefix: vi.fn(),
}));
vi.mock('@api/lib/edge-cache', () => ({
  setEdgeCache: (...a: unknown[]) => setEdgeCacheMock(...a),
  setBuyerPrivate: vi.fn(),
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: vi.fn().mockResolvedValue(false) },
}));
vi.mock('@api/services/product.service', () => ({
  ProductService: {
    listPublic: (...a: unknown[]) => listPublic(...a),
    getSuggestSuggestions: (...a: unknown[]) => suggest(...a),
  },
}));
vi.mock('@api/services/bundle.service', () => ({
  listSellableBundles: vi.fn().mockResolvedValue([]),
  withinSaleWindow: vi.fn(() => true),
  nextSaleWindowBoundarySeconds: vi.fn(() => Infinity),
  describeBundleContents: vi.fn(() => ({ description: '', descriptionAr: '' })),
}));
vi.mock('@api/utils/store-helpers', () => ({
  getStoreIdFromRequest: vi.fn().mockResolvedValue('store-1'),
  getAuthUser: vi.fn(),
}));
vi.mock('@api/lib/search/embed-budget', () => ({
  queryBudgetSpent: () => false,
  queryBudgetSpentUntil: () => 0,
  searcherFromIp: () => 'ip',
}));
vi.mock('@api/lib/search/embedding-provider', () => ({ semanticSearchEnabled: () => false }));
vi.mock('@api/services/search-log.service', () => ({
  claimSearcherSearch: vi.fn().mockResolvedValue(false),
  recordSearch: vi.fn(),
}));
vi.mock('@api/lib/after-tenant-commit', () => ({ deferAfterTenantCommit: vi.fn() }));
vi.mock('@api/middleware/security', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    publicLimiter: pass,
    publicTenantLimiter: pass,
    storeResolveLimiter: pass,
    storeMissLimiter: pass,
    publicSearchLimiter: pass,
    whenSearching: () => pass,
    cartLimiter: pass,
    couponAttemptLimiter: pass,
    guestReturnIpLimiter: pass,
    guestReturnOrderLimiter: pass,
    writeLimiter: pass,
    newsletterLimiter: pass,
    viewIngestLimiter: pass,
    auditLog: vi.fn(),
  };
});
vi.mock('@api/middleware/auth', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    authenticate: pass,
    optionalAuthenticate: pass,
    rejectImpersonated: pass,
    customerUserId: vi.fn(() => null),
  };
});
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@api/services/cart.service', () => ({ CartService: {} }));
vi.mock('@api/services/order.service', () => ({
  OrderService: { getById: (...a: unknown[]) => getById(...a) },
}));
vi.mock('@api/services/invoice.service', () => ({ InvoiceService: {} }));
vi.mock('@api/services/email.service', () => ({ EmailService: {} }));
vi.mock('@api/services/slug-redirect.service', () => ({
  resolveSlugRedirect: (...a: unknown[]) => h.raw(...a),
  resolveSlugRedirectCached: (...a: unknown[]) => h.cached(...a),
}));
vi.mock('@api/services/view-ingest.service', () => ({ recordProductView: vi.fn() }));
vi.mock('@api/lib/logger', () => {
  const rec = (...a: unknown[]) => void loggerCalls.push(a);
  return { default: { error: rec, warn: rec, info: rec, debug: rec } };
});

import publicRoutes from '@api/routes/public.routes';

const app = express();
app.use('/api/v1/public', publicRoutes);

beforeEach(() => {
  h.cached.mockReset();
  h.raw.mockReset();
});

describe('the public resolve route uses the cached resolver', () => {
  it('GET /redirects/resolve calls resolveSlugRedirectCached, not the raw chain walk', async () => {
    h.cached.mockResolvedValue('new-slug');
    const res = await request(app).get('/api/v1/public/redirects/resolve?type=product&slug=old');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ toSlug: 'new-slug' });
    expect(h.cached).toHaveBeenCalledWith('store-1', 'PRODUCT', 'old');
    expect(h.raw).not.toHaveBeenCalled();
  });

  it('a miss is a 200 with toSlug null (also through the cache), and a bad query never reaches either', async () => {
    h.cached.mockResolvedValue(null);
    const miss = await request(app).get('/api/v1/public/redirects/resolve?type=blog&slug=ghost');
    expect(miss.status).toBe(200);
    expect(miss.body).toEqual({ toSlug: null });
    const bad = await request(app).get('/api/v1/public/redirects/resolve?type=nope&slug=x');
    expect(bad.status).toBe(400);
    expect(h.cached).toHaveBeenCalledTimes(1);
    expect(h.raw).not.toHaveBeenCalled();
  });
});
