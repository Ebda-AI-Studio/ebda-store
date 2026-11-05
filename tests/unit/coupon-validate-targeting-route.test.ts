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

const { mockPrisma, mockLoadBuyerGroup } = vi.hoisted(() => ({
  mockLoadBuyerGroup: vi.fn(),
  mockPrisma: {
    coupon: { findFirst: vi.fn() },
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
  // Stand-in for a verified storefront token: `x-test-customer: <userId>`.
  optionalAuthenticate: (req: any, _res: any, next: any) => {
    const id = req.headers['x-test-customer'];
    if (id)
      req.user = { userId: id, role: 'customer', storeId: '11111111-1111-1111-1111-111111111111' };
    next();
  },
  customerUserId: (req: any) => (req.user?.role === 'customer' ? req.user.userId : undefined),
}));

// Group membership comes from the shared buyer-group loader (session / merchant pick only; Ruling B2B-2c). Its queries are
// pinned in tests/unit/price-resolver-service.test.ts and tests/integration/b2b-promo-identity.test.ts.
vi.mock('@api/services/price-resolver.service', () => ({
  loadBuyerGroup: mockLoadBuyerGroup,
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
  couponValidateDistinctLimiter: (_req: any, _res: any, next: any) => next(),
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
    // A KNOWN identity that is not in the group. (With no identity at all the
    // group is unknown, not a veto — see the #1368 cases below.)
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({ customerGroupId: 'vip-group' }));
    mockPrisma.order.count.mockResolvedValue(0);
    mockPrisma.customer.findFirst.mockResolvedValue({ groupId: 'regulars' });

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'SAVE10', cartItems: CART_ITEMS, phone: '+96550000001' });

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
    // 15% of 10000 piastres lineTotal = 1500 piastres.
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

  it('P2-a: rejects a bundle-only cart (orderTotal: 0) against a minOrderAmount coupon instead of silently applying it', async () => {
    // A bundle-only cart's coupon-quote basis is the loose subtotal, which
    // is legitimately 0 when the cart holds only bundle lines. The old
    // `orderTotal && …` truthiness guard treated 0 the same as "absent"
    // and skipped the minOrderAmount check entirely — the quote said
    // "applied", and checkout then 400ed at order.service.ts's own
    // minOrderAmount gate with no way for the customer to recover short of
    // clearing the code.
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({ minOrderAmount: 5000 }));

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'SAVE10', orderTotal: 0 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('MIN_ORDER_NOT_MET');
  });

  it('still applies a coupon with no minOrderAmount to a bundle-only cart (orderTotal: 0)', async () => {
    // Additive-safety check: a coupon with no minOrderAmount must not be
    // newly rejected just because orderTotal is 0.
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({ value: 20 }));

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'SAVE10', orderTotal: 0 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.discount).toBe(0);
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

describe('POST /public/:storeId/coupons/validate — storefront cart lines (#1368, #1379)', () => {
  // What the storefront now sends: loose lines WITHOUT category ids (the
  // cart never carries them). The route must resolve them itself.
  const STOREFRONT_ITEMS = [{ productId: 'p1', quantity: 2, lineTotal: 10000 }];

  beforeAll(async () => {
    app = await buildApp();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('resolves category ids from the store and refuses a category-scoped code the cart does not match', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue(
      couponRow({ type: 'free_shipping', value: 0, scopeCategoryIds: ['shoes'] })
    );
    mockPrisma.product.findMany.mockResolvedValue([
      { id: 'p1', categories: [{ categoryId: 'bags' }] },
    ]);

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'FREESHIP', orderTotal: 10000, cartItems: STOREFRONT_ITEMS });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('COUPON_NOT_ELIGIBLE');
    // Scoped to THIS store's products — never another tenant's categories.
    expect(mockPrisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['p1'] }, storeId: STORE_ID } })
    );
  });

  it('accepts the same code when the resolved categories match', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue(
      couponRow({ type: 'free_shipping', value: 0, scopeCategoryIds: ['shoes'] })
    );
    mockPrisma.product.findMany.mockResolvedValue([
      { id: 'p1', categories: [{ categoryId: 'shoes' }] },
    ]);

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'FREESHIP', orderTotal: 10000, cartItems: STOREFRONT_ITEMS });

    expect(res.status).toBe(200);
    expect(res.body.data.coupon.type).toBe('free_shipping');
  });

  it('refuses a first-order-only code to a typed identity that has ordered before', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({ firstOrderOnly: true }));
    mockPrisma.product.findMany.mockResolvedValue([{ id: 'p1', categories: [] }]);
    mockPrisma.order.count.mockResolvedValue(3);

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'WELCOME', cartItems: STOREFRONT_ITEMS, phone: '+96550000002' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('COUPON_NOT_ELIGIBLE');
  });

  it('does not refuse a customer-group code when no identity has been typed yet (cart page)', async () => {
    // Unknown is not ineligible: a VIP on the cart page must be able to apply
    // their code; checkout re-evaluates with the typed phone/email.
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({ customerGroupId: 'vip-group' }));
    mockPrisma.product.findMany.mockResolvedValue([{ id: 'p1', categories: [] }]);

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'VIP', orderTotal: 10000, cartItems: STOREFRONT_ITEMS });

    expect(res.status).toBe(200);
    // 10% of the 10000 piastres line.
    expect(res.body.data.discount).toBe(1000);
  });

  it('quotes a customer-group code by the SIGNED-IN account, not the typed contact (issue 2066)', async () => {
    // A VIP typing a recipient's phone: the typed phone is irrelevant; the session's customers.user_id link decides.
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({ customerGroupId: 'vip-group' }));
    mockPrisma.product.findMany.mockResolvedValue([{ id: 'p1', categories: [] }]);
    mockPrisma.order.count.mockResolvedValue(2);
    mockLoadBuyerGroup.mockResolvedValue({ id: 'vip-group' });

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .set('x-test-customer', 'user-vip')
      .send({ code: 'VIP', orderTotal: 10000, cartItems: STOREFRONT_ITEMS, phone: '+96550000077' });

    expect(res.status).toBe(200);
    expect(res.body.data.discount).toBe(1000);
    expect(mockLoadBuyerGroup).toHaveBeenCalledWith(
      STORE_ID,
      expect.objectContaining({ kind: 'session', userId: 'user-vip' })
    );
    expect(mockPrisma.customer.findFirst).not.toHaveBeenCalled();
  });

  it('a GUEST typing the VIP phone gets NO group code: the typed contact is not an identity (VIP-phone exploit)', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({ customerGroupId: 'vip-group' }));
    mockPrisma.product.findMany.mockResolvedValue([{ id: 'p1', categories: [] }]);
    mockPrisma.order.count.mockResolvedValue(0);
    mockPrisma.customer.findFirst.mockResolvedValue({ groupId: 'vip-group' }); // the old lookup would have matched
    mockLoadBuyerGroup.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'VIP', orderTotal: 10000, cartItems: STOREFRONT_ITEMS, phone: '+96550000001' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('COUPON_NOT_ELIGIBLE');
    expect(mockLoadBuyerGroup).toHaveBeenCalledWith(
      STORE_ID,
      expect.objectContaining({ kind: 'anonymous' })
    );
  });

  it('still refuses a GUEST whose typed contact matches no Customer row — order-create would too', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({ customerGroupId: 'vip-group' }));
    mockPrisma.product.findMany.mockResolvedValue([{ id: 'p1', categories: [] }]);
    mockPrisma.customer.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'VIP', orderTotal: 10000, cartItems: STOREFRONT_ITEMS, phone: '+96550000077' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('COUPON_NOT_ELIGIBLE');
  });

  it('B2B-5 quote: an all-tier cart (basis 0, no cart items) is quoted a 0 discount for a 10% coupon', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({ value: 10 }));
    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'SAVE', orderTotal: 0, cartItems: [] });
    expect(res.status).toBe(200);
    expect(res.body.data.discount).toBe(0);
  });

  it('B2B-5 quote: a minimum-order coupon on an all-tier cart (basis 0) is reported as not applicable', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({ value: 10, minOrderAmount: 5000 }));
    const res = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'SAVE', orderTotal: 0, cartItems: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MIN_ORDER_NOT_MET');
  });

  it('an unscoped code quotes the same discount as the whole-cart orderTotal path', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({ value: 15, maxDiscount: 1200 }));
    mockPrisma.product.findMany.mockResolvedValue([{ id: 'p1', categories: [] }]);

    const withLines = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'SAVE', orderTotal: 10000, cartItems: STOREFRONT_ITEMS });
    const totalOnly = await request(app)
      .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
      .send({ code: 'SAVE', orderTotal: 10000 });

    expect(withLines.body.data.discount).toBe(1200);
    expect(withLines.body.data.discount).toBe(totalOnly.body.data.discount);
  });

  describe('Ruling B2B-M2 (final review P2-3): a free-shipping code is judged on the whole loose cart', () => {
    const TIER_LINES = [{ productId: 'p1', categoryIds: ['c1'], quantity: 10, lineTotal: 85_000 }];
    const send = (body: Record<string, unknown>) =>
      request(app).post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`).send(body);

    it('an all-tier cart (base basis 0) meets a free-shipping minimum of 50000 through looseOrderTotal / looseCartItems', async () => {
      mockPrisma.coupon.findFirst.mockResolvedValue(
        couponRow({ type: 'free_shipping', value: 0, minOrderAmount: 50_000 })
      );
      const res = await send({
        code: 'SAVE10',
        orderTotal: 0,
        cartItems: [],
        looseOrderTotal: 85_000,
        looseCartItems: TIER_LINES,
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('a percentage code with the same minimum still judges the base basis (B2B-5) and refuses', async () => {
      mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({ minOrderAmount: 50_000 }));
      const res = await send({
        code: 'SAVE10',
        orderTotal: 0,
        cartItems: [],
        looseOrderTotal: 85_000,
        looseCartItems: TIER_LINES,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MIN_ORDER_NOT_MET');
    });

    it('an older client that sends no loose fields keeps the base-basis judgement', async () => {
      mockPrisma.coupon.findFirst.mockResolvedValue(
        couponRow({ type: 'free_shipping', value: 0, minOrderAmount: 50_000 })
      );
      const res = await send({ code: 'SAVE10', orderTotal: 0, cartItems: [] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MIN_ORDER_NOT_MET');
    });

    it('a malformed loose field is a clean 400, never reaching Prisma', async () => {
      mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({ type: 'free_shipping' }));
      const res = await send({ code: 'SAVE10', looseOrderTotal: -1 });
      expect(res.status).toBe(400);
    });
  });
});
