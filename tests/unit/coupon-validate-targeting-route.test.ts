/**
 * Route-level tests for the targeting extension to the public
 * `POST /public/:storeId/coupons/validate` endpoint (Task 6, Part 2).
 *
 * Boots a minimal Express app mounting only coupon.routes with auth/
 * store-access/rate-limit middleware stubbed out — matching the app-bootstrap
 * pattern in tests/unit/order-refund-route.test.ts. `CouponService` is
 * exercised for real (only Prisma is mocked) so the eligible/ineligible
 * targeting math runs end-to-end through the HTTP layer, mirroring
 * tests/unit/promotion-resolver.test.ts's "only Prisma is mocked" style.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ─── Mocks (declared before the route module is dynamically imported) ─────

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    coupon: { findFirst: vi.fn() },
    customer: { findFirst: vi.fn() },
    order: { count: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock('@force/database', () => ({
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
}));

vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
  checkStoreAccess: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature:
    (..._args: unknown[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));

vi.mock('@api/middleware/security', () => ({
  couponValidateLimiter: (_req: any, _res: any, next: any) => next(),
  publicTenantLimiter: (_req: any, _res: any, next: any) => next(),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── App bootstrap ──────────────────────────────────────────────────────────

let app: Express;

async function buildApp(): Promise<Express> {
  const { default: couponRouter } = await import('@api/routes/coupon.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const server = express();
  server.use(express.json());
  server.use('/api/v1/stores', couponRouter);
  server.use(errorHandler);
  return server;
}

const STORE_ID = '11111111-1111-1111-1111-111111111111';
const CART_ITEMS = [{ productId: 'p1', categoryIds: ['c1'], quantity: 2, lineTotal: 10000 }];

// Full Coupon shape (targeting facets empty = "everyone, whole cart").
function couponRow(overrides: Record<string, unknown>) {
  return {
    id: 'coupon-1',
    code: 'SAVE10',
    name: 'Save 10',
    nameAr: null,
    type: 'percentage',
    value: 10,
    minOrderAmount: null,
    maxDiscount: null,
    usageLimit: null,
    usageCount: 0,
    isActive: true,
    startsAt: null,
    expiresAt: null,
    customerGroupId: null,
    firstOrderOnly: false,
    minQuantity: null,
    scopeProductIds: [],
    scopeCategoryIds: [],
    ...overrides,
  };
}

describe('POST /public/:storeId/coupons/validate — targeting', () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 COUPON_NOT_ELIGIBLE when cartItems do not match the coupon targeting', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({ customerGroupId: 'vip-group' }));

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'SAVE10', cartItems: CART_ITEMS });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('COUPON_NOT_ELIGIBLE');
  });

  it('returns the cart-targeted discount when cartItems match the coupon targeting', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({ value: 15 }));

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'SAVE10', cartItems: CART_ITEMS });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // 15% of 10000 fils lineTotal = 1500 fils.
    expect(res.body.data.discount).toBe(1500);
  });

  it('preserves the original whole-cart calculation when cartItems is absent', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({ value: 20 }));

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'SAVE10', orderTotal: 5000 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // 20% of orderTotal 5000 = 1000 (whole-cart calculateDiscount path, not
    // evaluateForCart) — and no customer-context resolution should happen.
    expect(res.body.data.discount).toBe(1000);
    expect(mockPrisma.customer.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.order.count).not.toHaveBeenCalled();
  });

  it('keeps the generic INVALID_COUPON response for an unknown code (enumeration protection)', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'NOPE', cartItems: CART_ITEMS });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_COUPON');
  });

  it('ignores a body-supplied customerId instead of using it to resolve identity', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({ value: 15 }));

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'SAVE10', cartItems: CART_ITEMS, customerId: 'someone-elses-id' });

    expect(res.status).toBe(200);
    // customerId must never reach resolveCustomerContext's user lookup —
    // an unauthenticated caller must not be able to probe another
    // customer's segment/first-order status via a body-supplied id.
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('returns 400 (not 500) for a malformed phone value', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({}));

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'SAVE10', cartItems: CART_ITEMS, phone: { evil: 1 } });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 (not 500) for a malformed email value', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({}));

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'SAVE10', cartItems: CART_ITEMS, email: [] });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
