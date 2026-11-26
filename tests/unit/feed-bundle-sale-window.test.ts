/**
 * issues 2327 / 2328 — the AI product feed is cached (Redis 600s + edge
 * s-maxage/SWR), and crossing a bundle's `startsAt`/`expiresAt` is not a
 * write, so a feed built with the window baked in kept advertising an expired
 * bundle (and hid one whose window just opened) until the caches ran out.
 * Now the cache holds the window-free inputs, the window is applied per
 * request, and the edge lifetime ends before the next boundary.
 *
 * Mutation-proof: filtering on the window INSIDE the cached callback (the old
 * shape), or dropping the edge cap, reddens these.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockStoreFindUniqueOrThrow = vi.fn();
const mockBuildProductFeed = vi.fn(() => ({ products: [] }));

vi.mock('@ebda/database', () => ({
  prisma: {
    store: { findUniqueOrThrow: (...a: unknown[]) => mockStoreFindUniqueOrThrow(...a) },
    // the feed asks whether the store sells gold-rate products (Ruling B5-21 item 9): none here
    product: { count: async () => 0 },
  },
  SlugEntityType: {},
}));

vi.mock('@api/config', () => ({
  config: { webUrl: 'https://ebda.app', apiUrl: 'https://api.ebda.app' },
}));

vi.mock('@api/lib/product-feed', () => ({
  buildProductFeed: (...a: unknown[]) => mockBuildProductFeed(...(a as [])),
}));

// Run the real cache wrapper's body, never a cached value — this test is about
// what goes INTO the cache, and the poisoning bug was that the cache key does
// not include the host.
// A real-ish cache: the first call stores the JSON of the callback's value,
// later calls replay it — so the test proves the window is applied AFTER the
// cache read, on a value cached before the boundary.
const cache = new Map<string, unknown>();
const cacheKeys: string[] = [];
vi.mock('@api/lib/public-cache', () => ({
  getCached: async (key: string, _ttl: number, fn: () => unknown) => {
    cacheKeys.push(key);
    if (!cache.has(key)) cache.set(key, JSON.parse(JSON.stringify(await fn())));
    return cache.get(key);
  },
  invalidateCachedPrefix: vi.fn(),
}));

const mockSetEdgeCache = vi.fn();
vi.mock('@api/lib/edge-cache', () => ({
  setEdgeCache: (...a: unknown[]) => mockSetEdgeCache(...a),
}));

vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: vi.fn().mockResolvedValue(true) },
}));

vi.mock('@api/services/product.service', () => ({
  ProductService: { listPublic: vi.fn().mockResolvedValue({ products: [] }) },
}));

const mockListSellable = vi.fn();
vi.mock('@api/services/bundle.service', async () => {
  const real = await vi.importActual<typeof import('@api/services/bundle.service')>(
    '@api/services/bundle.service'
  );
  return {
    listSellableBundles: (...a: unknown[]) => mockListSellable(...a),
    withinSaleWindow: real.withinSaleWindow,
    nextSaleWindowBoundarySeconds: real.nextSaleWindowBoundarySeconds,
    describeBundleContents: vi.fn(() => ({ description: '', descriptionAr: '' })),
  };
});

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
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import publicRoutes from '@api/routes/public.routes';

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (...args: unknown[]) => unknown }>;
  };
}

function feedHandler() {
  const layers = (publicRoutes as unknown as { stack: RouteLayer[] }).stack;
  const layer = layers.find(l => l.route?.path === '/feed/products.json' && l.route.methods.get);
  if (!layer?.route) throw new Error('GET /feed/products.json not found');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (
    req: unknown,
    res: unknown,
    next: (err?: unknown) => void
  ) => Promise<void>;
}

function reqWith(headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: lower, get: (n: string) => lower[n.toLowerCase()], query: {}, params: {} };
}

const res = () => ({ json: vi.fn(), set: vi.fn(), setHeader: vi.fn(), status: vi.fn() });

const store = { id: 'store-1', name: 'S', slug: 'demo', currency: 'EGP', domain: null };
const bundle = (id: string, startsAt: Date | null, expiresAt: Date | null) => ({
  id,
  name: id,
  slug: id,
  price: 1000,
  componentSum: 1200,
  sellableIgnoringWindow: true,
  startsAt,
  expiresAt,
  updatedAt: new Date(),
  componentNames: [],
});
const bundleIdsPassed = (call: number) =>
  (mockBuildProductFeed.mock.calls[call][3] as unknown as Array<{ id: string }>).map(b => b.id);

describe('GET /public/feed/products.json — bundle sale window (issues 2327/2328)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: new Date('2026-10-01T20:00:00Z') });
    cache.clear();
    cacheKeys.length = 0;
    mockStoreFindUniqueOrThrow.mockResolvedValue(store);
  });
  afterEach(() => vi.useRealTimers());

  it('drops a bundle whose window closed after the feed was cached', async () => {
    const expiresAt = new Date('2026-10-01T20:05:00Z');
    mockListSellable.mockResolvedValue([
      bundle('ramadan', null, expiresAt),
      bundle('always', null, null),
    ]);

    await feedHandler()(reqWith({}), res(), vi.fn());
    expect(bundleIdsPassed(0).sort()).toEqual(['always', 'ramadan']);

    vi.setSystemTime(new Date('2026-10-01T20:06:00Z')); // past expiry, cache still warm
    await feedHandler()(reqWith({}), res(), vi.fn());
    expect(mockListSellable).toHaveBeenCalledTimes(1); // served from the cache
    expect(bundleIdsPassed(1)).toEqual(['always']);
  });

  it('shows a bundle whose window opened after the feed was cached', async () => {
    mockListSellable.mockResolvedValue([bundle('eid', new Date('2026-10-01T20:03:00Z'), null)]);
    await feedHandler()(reqWith({}), res(), vi.fn());
    expect(bundleIdsPassed(0)).toEqual([]);
    vi.setSystemTime(new Date('2026-10-01T20:04:00Z'));
    await feedHandler()(reqWith({}), res(), vi.fn());
    expect(bundleIdsPassed(1)).toEqual(['eid']);
  });

  it('caps the edge lifetime (fresh + stale) at the next window boundary', async () => {
    mockListSellable.mockResolvedValue([bundle('b', null, new Date('2026-10-01T20:02:00Z'))]);
    await feedHandler()(reqWith({}), res(), vi.fn());
    const opts = mockSetEdgeCache.mock.calls[0][1] as {
      sMaxAge: number;
      staleWhileRevalidate: number;
    };
    expect(opts.sMaxAge + opts.staleWhileRevalidate).toBeLessThanOrEqual(120);
  });

  it('keeps the long edge lifetime when no bundle has a future boundary', async () => {
    mockListSellable.mockResolvedValue([bundle('b', null, null)]);
    await feedHandler()(reqWith({}), res(), vi.fn());
    expect(mockSetEdgeCache.mock.calls[0][1]).toEqual({
      sMaxAge: 600,
      staleWhileRevalidate: 86400,
    });
  });

  it('uses the v2 key, so a v1 (built-feed) entry is never read', async () => {
    mockListSellable.mockResolvedValue([]);
    await feedHandler()(reqWith({}), res(), vi.fn());
    expect(cacheKeys).toContain('public:products:store-1:feed:v2');
  });
});
