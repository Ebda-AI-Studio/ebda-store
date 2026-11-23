/**
 * GET /public/feed/{google.xml,meta.xml,tiktok.csv} - fail-closed gate (404 when `product_feeds` is off, BEFORE any
 * parameter is read), Zod at the edge (lang/part), headers, and the bounded edge window (Ruling FEEDS-4).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const flags = vi.hoisted(
  () =>
    ({ product_feeds: true, 'inventory.backorder': false, bundles: false }) as Record<
      string,
      boolean
    >
);
const renderFeedMock = vi.hoisted(() => vi.fn());
const setEdgeCacheMock = vi.hoisted(() => vi.fn());
vi.mock('@api/lib/catalogue-feed/service', () => ({ renderFeed: renderFeedMock }));

vi.mock('@ebda/database', () => ({ prisma: {}, SlugEntityType: {}, withStore: vi.fn() }));

vi.mock('@api/config', () => ({
  config: { webUrl: 'https://ebda.app', apiUrl: 'https://api.ebda.app' },
}));

// Run the real cache wrapper's body, never a cached value — this test is about
// what goes INTO the cache, and the poisoning bug was that the cache key does
// not include the host.
vi.mock('@api/lib/public-cache', () => ({
  getCached: (_key: string, _ttl: number, fn: () => unknown) => fn(),
  invalidateCachedPrefix: vi.fn(),
}));

vi.mock('@api/lib/edge-cache', () => ({
  setEdgeCache: setEdgeCacheMock,
  setBuyerPrivate: vi.fn(),
}));

vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: vi.fn(async (_s: string, k: string) => flags[k] ?? false) },
}));

vi.mock('@api/services/product.service', () => ({
  ProductService: { listPublic: vi.fn().mockResolvedValue({ products: [] }) },
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
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import publicRoutes from '@api/routes/public.routes';

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (...a: unknown[]) => unknown }>;
  };
}
function handler(path: string) {
  const layer = (publicRoutes as unknown as { stack: RouteLayer[] }).stack.find(
    l => l.route?.path === path && l.route.methods.get
  );
  if (!layer?.route) throw new Error(`GET ${path} not found`);
  const s = layer.route.stack;
  return s[s.length - 1].handle as (
    req: unknown,
    res: unknown,
    next: (e?: unknown) => void
  ) => Promise<void>;
}
const res = () => ({ setHeader: vi.fn(), send: vi.fn(), json: vi.fn() });
const doc = {
  body: '<rss/>',
  contentType: 'application/xml; charset=utf-8',
  nextPart: 2,
  edgeSeconds: 300,
};

describe.each([
  ['/feed/google.xml', 'google'],
  ['/feed/meta.xml', 'meta'],
  ['/feed/tiktok.csv', 'tiktok'],
] as const)('GET /public%s', (path, platform) => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.product_feeds = true;
    renderFeedMock.mockResolvedValue(doc);
  });

  it('404s when product_feeds is off, before reading any parameter or building anything', async () => {
    flags.product_feeds = false;
    const next = vi.fn();
    await handler(path)({ query: { lang: 'zz' }, params: {}, headers: {} }, res(), next);
    expect((next.mock.calls[0][0] as { statusCode: number }).statusCode).toBe(404);
    expect(renderFeedMock).not.toHaveBeenCalled();
  });

  it('rejects a bad lang or part with 400 (Zod at the edge)', async () => {
    for (const query of [{ lang: 'fr' }, { part: '0' }, { part: 'x' }, { part: '9999' }]) {
      const next = vi.fn();
      await handler(path)({ query, params: {}, headers: {} }, res(), next);
      expect((next.mock.calls[0][0] as { statusCode: number }).statusCode).toBe(400);
    }
    expect(renderFeedMock).not.toHaveBeenCalled();
  });

  it('defaults to Arabic part 1, forwards the platform and entitlements, sets type, next-part and a bounded edge window', async () => {
    const r = res();
    await handler(path)({ query: {}, params: {}, headers: {} }, r, vi.fn());
    expect(renderFeedMock).toHaveBeenCalledWith({
      storeId: 'store-1',
      platform,
      lang: 'ar',
      part: 1,
      backorderOn: false,
      bundlesEnabled: false,
    });
    expect(r.setHeader).toHaveBeenCalledWith('Content-Type', 'application/xml; charset=utf-8');
    expect(r.setHeader).toHaveBeenCalledWith('X-Feed-Next-Part', '2');
    expect(r.send).toHaveBeenCalledWith('<rss/>');
    expect(setEdgeCacheMock).toHaveBeenCalledWith(expect.anything(), {
      sMaxAge: 300,
      staleWhileRevalidate: 0,
      neverStale: true,
    });
  });

  it('404s a part that does not exist', async () => {
    renderFeedMock.mockResolvedValue(null);
    const next = vi.fn();
    await handler(path)({ query: { part: '7' }, params: {}, headers: {} }, res(), next);
    expect((next.mock.calls[0][0] as { statusCode: number }).statusCode).toBe(404);
  });
});
