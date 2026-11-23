/**
 * Route-level tests for the public storefront promotion-preview endpoint
 * (Task 6, Part 1): `POST /public/:storeId/promotions/preview`.
 *
 * Boots a minimal Express app mounting only promotion.routes with auth/
 * store-access/rate-limit middleware stubbed out — matching the app-bootstrap
 * pattern in tests/unit/order-refund-route.test.ts. `resolveCustomerContext`/
 * `resolveBestPromotion` run for real (only Prisma is mocked), same style as
 * tests/unit/promotion-resolver.test.ts, so the test exercises the real
 * targeting math end-to-end through the HTTP layer.
 *
 * Companion: `tests/integration/promotions-preview.test.ts` covers what a mock
 * cannot — cross-tenant product scoping and the resolver's active/expiry/type
 * filters against a real Postgres. Neither file is a duplicate of the other.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ─── Mocks (declared before the route module is dynamically imported) ─────

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    promotion: { findMany: vi.fn() },
    customer: { findFirst: vi.fn() },
    order: { count: vi.fn() },
    user: { findUnique: vi.fn() },
    product: { findMany: vi.fn() },
  },
}));

vi.mock('@ebda/database', () => ({
  prisma: mockPrisma,
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
}));

vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin' };
    next();
  },
  authorize:
    (..._roles: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
  // The preview prices lines for the signed-in customer (none in these tests: anonymous).
  optionalAuthenticate: (_req: any, _res: any, next: any) => next(),
  customerUserId: () => undefined,
}));

// Lines are priced by the real pure resolver with no tiers / group (retail), see tests/helpers/retail-price-resolver.ts.
vi.mock('@api/services/price-resolver.service', async () =>
  (await import('../helpers/retail-price-resolver')).retailPriceResolverModule()
);

vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
  checkStoreAccess: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/middleware/security', () => ({
  promotionPreviewLimiter: (_req: any, _res: any, next: any) => next(),
  promotionBrowsePreviewLimiter: (_req: any, _res: any, next: any) => next(),
  publicTenantLimiter: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── App bootstrap ──────────────────────────────────────────────────────────

let app: Express;

async function buildApp(): Promise<Express> {
  const { default: promotionRouter } = await import('@api/routes/promotion.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const server = express();
  server.use(express.json());
  server.use('/api/v1/stores', promotionRouter);
  server.use(errorHandler);
  return server;
}

const STORE_ID = '11111111-1111-1111-1111-111111111111';

// Full Targeting + Promotion shape (all facets empty = "everyone, whole cart").
function promo(overrides: Record<string, unknown>) {
  return {
    id: 'promo',
    priority: 0,
    type: 'percentage',
    value: 10,
    maxDiscount: null,
    customerGroupId: null,
    firstOrderOnly: false,
    minOrderAmount: null,
    minQuantity: null,
    scopeProductIds: [],
    scopeCategoryIds: [],
    createdAt: new Date(),
    startsAt: null,
    expiresAt: null,
    ...overrides,
  };
}

// Storefront-supplied request shape — no category ids or line totals, the
// route must server-resolve those from Product.
const ITEMS = [{ productId: 'p1', quantity: 2 }];

// What the server should look up for product p1: price 5000 piastres, category
// c1 — so the server-built snapshot line total is 5000 * 2 = 10000 piastres,
// matching the promotion-math fixtures below.
const PRODUCTS = [{ id: 'p1', price: 5000, categories: [{ categoryId: 'c1' }] }];

describe('POST /public/:storeId/promotions/preview', () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the best eligible promotion computed from the server-resolved cart', async () => {
    mockPrisma.product.findMany.mockResolvedValue(PRODUCTS);
    mockPrisma.promotion.findMany.mockResolvedValue([
      promo({ id: 'A', priority: 10, value: 10 }), // 1000 piastres
      promo({ id: 'B', priority: 5, value: 20 }), // 2000 piastres
    ]);

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/promotions/preview`)
      .send({ items: ITEMS });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // 2000 piastres only follows if the server built lineTotal = 5000*2 from the
    // looked-up product price, not from anything the client sent.
    expect(res.body.data.promotion).toEqual({ id: 'B', discount: 2000 });
  });

  it('ignores a client-supplied lineTotal/categoryIds since the route no longer accepts them', async () => {
    mockPrisma.product.findMany.mockResolvedValue(PRODUCTS);
    // Only a promotion scoped to c2 (not the product's real category c1)
    // would apply if the client's fabricated categoryIds were trusted.
    mockPrisma.promotion.findMany.mockResolvedValue([
      promo({ id: 'REAL_CATEGORY', value: 10, scopeCategoryIds: ['c1'] }),
    ]);

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/promotions/preview`)
      .send({
        items: ITEMS,
        // Not part of the schema anymore — must be ignored, not trusted.
        cartItems: [{ productId: 'p1', categoryIds: ['c2'], quantity: 2, lineTotal: 999999 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.promotion).toEqual({ id: 'REAL_CATEGORY', discount: 1000 });
  });

  it('skips a requested item whose product is not found', async () => {
    mockPrisma.product.findMany.mockResolvedValue([]); // product lookup misses
    mockPrisma.promotion.findMany.mockResolvedValue([promo({ id: 'A', value: 10 })]);

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/promotions/preview`)
      .send({ items: [{ productId: 'missing', quantity: 3 }] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Empty cart snapshot (skipped item) → nothing to discount against.
    expect(res.body.data.promotion).toBeNull();
  });

  it('returns null when no promotion is eligible for the cart', async () => {
    mockPrisma.product.findMany.mockResolvedValue(PRODUCTS);
    mockPrisma.promotion.findMany.mockResolvedValue([
      promo({ id: 'WRONG_GROUP', value: 50, customerGroupId: 'g2' }),
    ]);

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/promotions/preview`)
      .send({ items: ITEMS });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.promotion).toBeNull();
  });

  it('returns null when there are no active promotions at all', async () => {
    mockPrisma.product.findMany.mockResolvedValue(PRODUCTS);
    mockPrisma.promotion.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/promotions/preview`)
      .send({ items: ITEMS });

    expect(res.status).toBe(200);
    expect(res.body.data.promotion).toBeNull();
  });

  it('rejects a malformed body (items missing) with a 400', async () => {
    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/promotions/preview`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('is reachable with no authentication (public endpoint)', async () => {
    mockPrisma.product.findMany.mockResolvedValue(PRODUCTS);
    mockPrisma.promotion.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/promotions/preview`)
      // Deliberately no Authorization header.
      .send({ items: ITEMS });

    expect(res.status).toBe(200);
  });

  it('ignores a body-supplied customerId instead of using it to resolve identity', async () => {
    mockPrisma.product.findMany.mockResolvedValue(PRODUCTS);
    mockPrisma.promotion.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/promotions/preview`)
      .send({ items: ITEMS, customerId: 'someone-elses-id' });

    expect(res.status).toBe(200);
    // customerId must never reach resolveCustomerContext's user lookup —
    // an unauthenticated caller must not be able to probe another
    // customer's segment/first-order status via a body-supplied id.
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  describe('browse route (PDP / cart): no identity oracle', () => {
    const FIRST_ORDER_PROMO = () => promo({ id: 'F', value: 10, firstOrderOnly: true });

    it('ignores a body phone / email: a known customer gets the same answer as a stranger, and no order lookup runs', async () => {
      mockPrisma.product.findMany.mockResolvedValue(PRODUCTS);
      mockPrisma.promotion.findMany.mockResolvedValue([FIRST_ORDER_PROMO()]);
      mockPrisma.order.count.mockResolvedValue(3); // this phone HAS prior orders

      const withPhone = await request(app)
        .post(`/api/v1/stores/public/${STORE_ID}/promotions/preview-browse`)
        .send({ items: ITEMS, phone: '+201001234567', email: 'vip@example.com' });
      const without = await request(app)
        .post(`/api/v1/stores/public/${STORE_ID}/promotions/preview-browse`)
        .send({ items: ITEMS });

      expect(withPhone.status).toBe(200);
      expect(withPhone.body.data).toEqual(without.body.data);
      expect(withPhone.body.data.promotion).toEqual({ id: 'F', discount: 1000 });
      expect(mockPrisma.order.count).not.toHaveBeenCalled();
    });

    it('checkout route still evaluates identity: a phone with prior orders loses a first-order promo', async () => {
      mockPrisma.product.findMany.mockResolvedValue(PRODUCTS);
      mockPrisma.promotion.findMany.mockResolvedValue([FIRST_ORDER_PROMO()]);
      mockPrisma.order.count.mockResolvedValue(3);

      const res = await request(app)
        .post(`/api/v1/stores/public/${STORE_ID}/promotions/preview`)
        .send({ items: ITEMS, phone: '+201001234567' });

      expect(res.status).toBe(200);
      expect(mockPrisma.order.count).toHaveBeenCalledTimes(1);
      expect(res.body.data.promotion).toBeNull();
    });
  });
});
