/**
 * P1-2 — AI product-feed poisoning via `X-Original-Host`.
 *
 * `GET /public/feed/products.json` derived `baseUrl` from
 * `req.get('x-original-host') ?? req.get('host')` whenever the store had no
 * custom domain, and NOTHING in the middleware chain strips inbound headers
 * (`trust proxy` is a hop COUNT, not a filter). The resulting feed — every
 * `link` pointing at the attacker's host — was then cached in Redis under
 * `public:products:<storeId>:feed:v2` (a key with no host in it) for 600s AND
 * at the CDN for 600s + 86400s SWR. One request poisoned every subsequent AI
 * agent's product links for the store, and `X-Store-ID`/`x-store-domain` let
 * the attacker choose ANY active store as the target.
 *
 * The fallback is now `storefrontOrigin(store)` (`https://<slug>.ebda.app`) — the
 * same derivation `order.tools.ts`'s `storefrontBaseUrl` and `payment.routes.ts`
 * use. FM-6: the `store.domain` branch must be preserved verbatim, or every
 * custom-domain merchant's feed starts pointing at the platform subdomain instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('@api/lib/public-cache', () => ({
  getCached: (_key: string, _ttl: number, fn: () => unknown) => fn(),
  invalidateCachedPrefix: vi.fn(),
}));

vi.mock('@api/lib/edge-cache', () => ({ setEdgeCache: vi.fn() }));

vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: vi.fn().mockResolvedValue(true) },
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

/** Third positional argument of buildProductFeed(store, products, baseUrl, bundles). */
function baseUrlPassed(): string {
  return mockBuildProductFeed.mock.calls[0][2] as unknown as string;
}

describe('GET /public/feed/products.json — baseUrl ignores request headers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ignores an attacker-supplied X-Original-Host for a platform-hosted store', async () => {
    mockStoreFindUniqueOrThrow.mockResolvedValue({
      id: 'store-1',
      name: 'S',
      slug: 'demo',
      currency: 'EGP',
      domain: null,
    });
    const next = vi.fn();

    await feedHandler()(
      reqWith({ 'x-original-host': 'attacker.example', host: 'api.ebda.app' }),
      res(),
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(baseUrlPassed()).toBe('https://demo.ebda.app');
    expect(baseUrlPassed()).not.toContain('attacker.example');
  });

  it('ignores the Host header too — no request-supplied value reaches the feed', async () => {
    mockStoreFindUniqueOrThrow.mockResolvedValue({
      id: 'store-1',
      name: 'S',
      slug: 'demo',
      currency: 'EGP',
      domain: null,
    });

    await feedHandler()(reqWith({ host: 'evil.example' }), res(), vi.fn());

    expect(baseUrlPassed()).toBe('https://demo.ebda.app');
  });

  it('produces the SAME baseUrl for two different X-Original-Host values (cache-key completeness)', async () => {
    mockStoreFindUniqueOrThrow.mockResolvedValue({
      id: 'store-1',
      name: 'S',
      slug: 'demo',
      currency: 'EGP',
      domain: null,
    });

    await feedHandler()(reqWith({ 'x-original-host': 'a.example' }), res(), vi.fn());
    await feedHandler()(reqWith({ 'x-original-host': 'b.example' }), res(), vi.fn());

    const first = mockBuildProductFeed.mock.calls[0][2];
    const second = mockBuildProductFeed.mock.calls[1][2];
    expect(second).toBe(first);
  });

  it('FM-6 — keeps the custom-domain branch verbatim', async () => {
    mockStoreFindUniqueOrThrow.mockResolvedValue({
      id: 'store-1',
      name: 'S',
      slug: 'demo',
      currency: 'EGP',
      domain: 'shop.merchant.com',
    });

    await feedHandler()(reqWith({ 'x-original-host': 'attacker.example' }), res(), vi.fn());

    expect(baseUrlPassed()).toBe('https://shop.merchant.com');
  });
});
