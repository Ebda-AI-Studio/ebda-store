/**
 * Ruling SEARCH-URL-1 (launch blocker 31), API half: the storefront list (`GET /public/products`)
 * and the typeahead (`GET /public/:storeId/search/suggest`) read the shopper's term from the
 * `X-Search-Query` header, never log it, and never let a shared cache (Cloudflare ignores `Vary`)
 * store a response that depends on it. The deprecated `?search=` / `?q=` forms still answer for
 * one release and stay edge-cacheable as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { listPublic, suggest, loggerCalls, setEdgeCacheMock } = vi.hoisted(() => ({
  listPublic: vi.fn(),
  suggest: vi.fn(),
  loggerCalls: [] as unknown[][],
  setEdgeCacheMock: vi.fn(),
}));

vi.mock('@ebda/database', () => ({ prisma: {}, SlugEntityType: {} }));
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
vi.mock('@api/services/order.service', () => ({ OrderService: {} }));
vi.mock('@api/services/invoice.service', () => ({ InvoiceService: {} }));
vi.mock('@api/services/email.service', () => ({ EmailService: {} }));
vi.mock('@api/services/slug-redirect.service', () => ({
  resolveSlugRedirect: vi.fn(),
  resolveSlugRedirectCached: vi.fn(),
}));
vi.mock('@api/services/view-ingest.service', () => ({ recordProductView: vi.fn() }));
vi.mock('@api/lib/logger', () => {
  const rec = (...a: unknown[]) => void loggerCalls.push(a);
  return { default: { error: rec, warn: rec, info: rec, debug: rec } };
});

import publicRoutes from '@api/routes/public.routes';

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (...args: unknown[]) => unknown }>;
  };
}
function handlerFor(path: string) {
  const layers = (publicRoutes as unknown as { stack: RouteLayer[] }).stack;
  const layer = layers.find(l => l.route?.path === path && l.route.methods.get);
  if (!layer?.route) throw new Error(`GET ${path} not found`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (
    req: unknown,
    res: unknown,
    next: (err?: unknown) => void
  ) => Promise<void>;
}

const PHONE = '01012345678';
const TERM = `منى ${PHONE}`;
const STORE = '11111111-1111-4111-8111-111111111111';

function mkReq(opts: { query?: Record<string, string>; header?: string; params?: object }) {
  const headers: Record<string, string> = opts.header
    ? { 'x-search-query': encodeURIComponent(opts.header) }
    : {};
  return {
    headers,
    get: (n: string) => headers[n.toLowerCase()],
    query: opts.query ?? {},
    params: opts.params ?? {},
    ip: '203.0.113.9',
  };
}
function mkRes() {
  const headers: Record<string, string> = {};
  const varied: string[] = [];
  return {
    headers,
    varied,
    json: vi.fn(),
    setHeader: (k: string, v: string) => void (headers[k] = v),
    vary: (f: string) => void varied.push(f),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loggerCalls.length = 0;
  listPublic.mockResolvedValue({ products: [], meta: { total: 0, page: 1, limit: 20 } });
  suggest.mockResolvedValue({ suggestions: [] });
});

describe('GET /public/products', () => {
  it('searches the header term, keeps it out of every log line, and never edge-caches the answer', async () => {
    const res = mkRes();
    const next = vi.fn();
    await handlerFor('/products')(mkReq({ header: TERM }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(listPublic.mock.calls[0][1].search).toBe(TERM);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(res.varied).toContain('X-Search-Query');
    expect(setEdgeCacheMock).not.toHaveBeenCalled();
    expect(JSON.stringify(loggerCalls)).not.toContain(PHONE);
  });

  it('the header wins over a stale ?search= and an absent term stays edge-cacheable', async () => {
    const res = mkRes();
    await handlerFor('/products')(
      mkReq({ header: 'bags', query: { search: 'shoes' } }),
      res,
      vi.fn()
    );
    expect(listPublic.mock.calls[0][1].search).toBe('bags');

    const plain = mkRes();
    await handlerFor('/products')(mkReq({ query: { category: 'c' } }), plain, vi.fn());
    expect(setEdgeCacheMock).toHaveBeenCalledTimes(1);
    expect(plain.varied).not.toContain('X-Search-Query');
  });

  it('the deprecated ?search= form still answers (older storefront bundles)', async () => {
    await handlerFor('/products')(mkReq({ query: { search: 'shoes' } }), mkRes(), vi.fn());
    expect(listPublic.mock.calls[0][1].search).toBe('shoes');
  });
});

describe('GET /public/:storeId/search/suggest', () => {
  it('reads the header term, not the URL, and marks the answer private + no-store', async () => {
    const res = mkRes();
    await handlerFor('/:storeId/search/suggest')(
      mkReq({ header: TERM, params: { storeId: STORE } }),
      res,
      vi.fn()
    );
    expect(suggest).toHaveBeenCalledWith(STORE, TERM, 25);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(res.varied).toContain('X-Search-Query');
    expect(JSON.stringify(loggerCalls)).not.toContain(PHONE);
  });

  it('the deprecated ?q= form still answers', async () => {
    await handlerFor('/:storeId/search/suggest')(
      mkReq({ query: { q: 'shoes' }, params: { storeId: STORE } }),
      mkRes(),
      vi.fn()
    );
    expect(suggest).toHaveBeenCalledWith(STORE, 'shoes', 25);
  });
});
