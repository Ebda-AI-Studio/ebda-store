/**
 * SEC-15 / M-137, route half: `GET /public/orders/:id` shows a guest order's address and phone
 * only to a holder of the signed view token, and never lets one customer read another's order.
 * Behaviour, not source text: the REAL route handler runs against a faked OrderService and the
 * real token + mask code, so a masking call that sits in a comment, a dead branch or the wrong
 * route cannot satisfy it. (Replaces a 3000-character text window after the route path in
 * guest-order-view-token.test.ts.)
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

const { getById, loggerCalls, setEdgeCacheMock, listPublic, suggest } = vi.hoisted(() => ({
  getById: vi.fn(),
  loggerCalls: [] as unknown[][],
  setEdgeCacheMock: vi.fn(),
  listPublic: vi.fn(),
  suggest: vi.fn(),
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
vi.mock('@api/services/order.service', () => ({
  OrderService: { getById: (...a: unknown[]) => getById(...a) },
}));
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

const A = '11111111-1111-4111-8111-111111111111';

const guestOrder = (over: Record<string, unknown> = {}) => ({
  id: A,
  orderNumber: 'EB-1',
  status: 'pending',
  paymentStatus: 'unpaid',
  currency: 'EGP',
  total: 12345,
  customerId: null,
  items: [],
  payments: [],
  notes: null,
  shippingAddress: {
    firstName: 'Mona',
    address1: '12 Tahrir St, flat 4',
    city: 'Cairo',
    phone: '01012345678',
  },
  ...over,
});

function orderHandler() {
  const layers = (
    publicRoutes as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: unknown }>;
        };
      }>;
    }
  ).stack;
  const layer = layers.find(l => l.route?.path === '/orders/:id' && l.route.methods.get);
  if (!layer?.route) throw new Error('GET /orders/:id not found');
  return layer.route.stack[layer.route.stack.length - 1].handle as (
    req: unknown,
    res: unknown,
    next: (e?: unknown) => void
  ) => Promise<void>;
}

async function call(order: unknown, opts: { token?: string; user?: object } = {}) {
  getById.mockResolvedValue(order);
  const headers: Record<string, string> = opts.token ? { 'x-order-view-token': opts.token } : {};
  const req = {
    params: { id: A },
    headers,
    get: (n: string) => headers[n.toLowerCase()],
    user: opts.user,
  };
  const out: { status?: number; body?: unknown } = {};
  const res = {
    status: (c: number) => ((out.status = c), res),
    json: (b: unknown) => ((out.body = b), res),
    setHeader: vi.fn(),
    vary: vi.fn(),
  };
  const next = vi.fn();
  await orderHandler()(req, res, next);
  expect(next).not.toHaveBeenCalled();
  return out;
}

beforeAll(() => {
  process.env.ORDER_VIEW_SECRET = 'test-order-view-secret';
});

describe('GET /orders/:id masks unless a customer or a valid token', () => {
  it('a guest without the token gets the masked view (no address or phone)', async () => {
    const { body } = await call(guestOrder());
    const json = JSON.stringify(body);
    expect(json).toContain('EB-1');
    expect(json).not.toMatch(/Tahrir|01012345678|Mona/);
  });
  it('a guest holding the order token gets the full address', async () => {
    const { signOrderViewToken } = await import('@api/lib/order-view-token');
    const { body } = await call(guestOrder(), { token: signOrderViewToken(A) });
    expect(JSON.stringify(body)).toContain('12 Tahrir St');
  });
  it('a token for ANOTHER order does not unmask', async () => {
    const { signOrderViewToken } = await import('@api/lib/order-view-token');
    const other = '22222222-2222-4222-8222-222222222222';
    const { body } = await call(guestOrder(), { token: signOrderViewToken(other) });
    expect(JSON.stringify(body)).not.toContain('Tahrir');
  });
  it('an order that belongs to a customer is refused to anyone but that customer', async () => {
    const owned = guestOrder({ customerId: 'c1' });
    expect((await call(owned)).status).toBe(403);
    expect((await call(owned, { user: { role: 'customer', userId: 'c2' } })).status).toBe(403);
    const mine = await call(owned, { user: { role: 'customer', userId: 'c1' } });
    expect(JSON.stringify(mine.body)).toContain('12 Tahrir St');
  });
});
