/**
 * P1 (money) — a bundle whose discount outgrew its own components must stop
 * selling EVERYWHERE at once.
 *
 * `resolveBundle` recomputes `componentSum` from the components' CURRENT
 * prices on every read, and `computeBundlePrice` clamps
 * `componentSum - pricingValue` with `Math.max(0, …)`. A `fixed` (piastres-off)
 * discount that was a real discount when the merchant saved it therefore
 * becomes a 100%-off discount the moment a sale, a bulk edit or a CSV import
 * drops the component prices below it — with no merchant error anywhere, and
 * with nothing downstream to catch it: the public list serves `{ price: 0 }`,
 * `CartService.addBundle` gates only on `isPurchasable`, the checkout recheck
 * gates only on `isPurchasable`, and order.service's money-invariant guard
 * passes because `allocateBundlePrice(lines, 0)` returns all zeros and
 * `0 === resolved.price`. The customer pays nothing for real,
 * stock-decrementing goods and the merchant ships the box.
 *
 * The fix is ONE predicate — `price > 0 || componentSum === 0`, inside
 * `resolveBundle`'s `isPurchasable` — precisely so it cannot be applied to
 * some selling surfaces and forgotten on others. This file is the proof of
 * that claim: the SAME drifted bundle is driven through all three surfaces
 * (public storefront list, add-to-cart, checkout), each with the real
 * service/route code and only Prisma mocked, and each is paired with a
 * pre-drift control so a green result can never come from the fixture simply
 * failing everywhere.
 *
 * `tests/unit/bundle-availability.test.ts` covers the predicate itself (plus
 * the legitimate `componentSum === 0` free kit); `bundle-save-time-guards`
 * covers the save-time half that stops the bundle being born this way.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const STORE_ID = '11111111-1111-1111-1111-111111111111';
const BUNDLE_ID = 'bundle-1';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/**
 * "Ramadan Box": one component, quantity 1, sold at `pricingType: 'fixed'`
 * with 5.000 EGP off. At the component's original 20.000 the box is 15.000;
 * after the component is repriced to 4.500 the discount swallows it whole
 * and `computeBundlePrice` clamps the box to 0.
 */
const DISCOUNT_FILS = 5000;
const PRICE_BEFORE_DRIFT = 20000;
const PRICE_AFTER_DRIFT = 4500;

const bundleRow = (componentPrice: number) => ({
  id: BUNDLE_ID,
  storeId: STORE_ID,
  name: 'Ramadan Box',
  nameAr: null,
  slug: 'ramadan-box',
  image: null,
  description: null,
  descriptionAr: null,
  pricingType: 'fixed',
  pricingValue: DISCOUNT_FILS,
  isActive: true,
  startsAt: null,
  expiresAt: null,
  items: [
    {
      id: 'bi-1',
      productId: 'p-dates',
      quantity: 1,
      variantId: null,
      variant: null,
      product: {
        price: componentPrice,
        trackInventory: false,
        inventory: 0,
        variants: [],
        deletedAt: null,
        status: 'active',
      },
    },
  ],
});

const BUNDLE_ITEM_ROWS = [
  {
    id: 'bi-1',
    productId: 'p-dates',
    variantId: null,
    quantity: 1,
    product: { name: 'Dates', sku: 'D-1', costPrice: null, trackInventory: false },
  },
];

const CART_ROW = {
  id: 'cart-1',
  storeId: STORE_ID,
  sessionId: 'sess-1',
  customerId: null,
  items: [],
  bundles: [{ id: 'cb-1', bundleId: BUNDLE_ID, quantity: 1 }],
};

// ─── Mocks ──────────────────────────────────────────────────────────────────

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    bundle: { findFirst: vi.fn(), findMany: vi.fn() },
    bundleItem: { findMany: vi.fn() },
    cart: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    cartBundle: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn(), update: vi.fn() },
    coupon: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn() },
    product: { findMany: vi.fn().mockResolvedValue([]) },
    store: { findUnique: vi.fn().mockResolvedValue({ name: 'Test Store', settings: null }) },
    taxRate: { findMany: vi.fn().mockResolvedValue([]) },
    storeTaxProfile: { findUnique: vi.fn().mockResolvedValue(null) },
    customer: { findFirst: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn() },
    promotion: { findMany: vi.fn().mockResolvedValue([]) },
    order: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn(), create: vi.fn() },
    orderEvent: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    inventoryHistory: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    backorderLine: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi
      .fn()
      .mockResolvedValue([{ inventory: 50, phone_or_email_count: 0n, ip_count: 0n }]),
    // `hasTenantContext` is mocked `true` below, so CartService.addBundle takes
    // the ambient-transaction path and brackets its write in a Postgres
    // SAVEPOINT (apps/api/src/lib/savepoint.ts). Without this the mock throws
    // "$executeRawUnsafe is not a function" before any pricing assertion runs.
    $executeRawUnsafe: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: vi.fn(async (fn: any) => {
      if (typeof fn !== 'function') return fn;
      return fn({
        order: {
          create: vi.fn().mockResolvedValue({
            id: 'order-1',
            orderNumber: 'ORD-1',
            storeId: STORE_ID,
            items: [],
            customer: null,
          }),
          count: vi.fn().mockResolvedValue(0),
        },
        coupon: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        product: { update: vi.fn(), findUnique: vi.fn() },
        productVariant: { update: vi.fn(), findUnique: vi.fn() },
        cartItem: {
          findMany: vi.fn(async () => CART_ROW.items),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          count: vi.fn().mockResolvedValue(0),
        },
        cartBundle: {
          findMany: vi.fn(async () => CART_ROW.bundles),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          count: vi.fn().mockResolvedValue(1),
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn(),
          update: vi.fn(),
        },
        inventoryHistory: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn(),
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        orderEvent: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
        $executeRaw: vi.fn().mockResolvedValue(1),
        $queryRaw: vi
          .fn()
          .mockResolvedValue([{ inventory: 50, phone_or_email_count: 0n, ip_count: 0n }]),
      });
    }),
  },
}));

// Money batch B: fiscal documents + the frozen COD fee are covered end-to-end
// by tests/integration/fiscal-documents.test.ts; this unit suite stubs them.
vi.mock('@api/services/fiscal-document.service', () => ({
  FiscalDocumentService: {
    issueSaleDocument: vi.fn().mockResolvedValue(null),
    cancelSaleDocument: vi.fn().mockResolvedValue(null),
    issueRefundDocument: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('@api/services/payment-providers/cod.provider', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/services/payment-providers/cod.provider')>()),
  loadCodFeeConfig: vi.fn().mockResolvedValue(null),
}));
vi.mock('@ebda/database', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scopeTransaction: (tx: any, _g: unknown, fn: any) => fn(tx),
  prisma: mockPrisma,
  Prisma: { TransactionIsolationLevel: { ReadCommitted: 'ReadCommitted' } },
  OrderStatus: {},
  // `true` puts CartService.addBundle on its ambient-transaction path (the
  // one every real request takes — cart.routes.ts's mount always opens one),
  // so the write runs inline on `prisma` rather than opening a nested
  // transaction the mock would have to model.
  hasTenantContext: () => true,
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withStore: (_storeId: string, fn: any) => fn(mockPrisma),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withMoneyTx: (client: any, fn: any) =>
    client?.$transaction ? client.$transaction(fn) : fn(client),
}));

vi.mock('@api/services/email.service', () => ({
  EmailService: {
    sendOrderConfirmation: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('@api/services/socket.service', () => ({
  socketService: { newOrderNotification: vi.fn(), orderStatusNotification: vi.fn() },
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { send: vi.fn().mockResolvedValue({ ids: [] }), createFunction: vi.fn(() => ({})) },
}));
// Order-cap gate has its own suite (order-plan-grace.test.ts); stubbed here.
vi.mock('@api/services/plan-limit.service', () => ({
  assertOrderAllowed: vi.fn().mockResolvedValue(undefined),
  noteOrderCreated: vi.fn().mockResolvedValue({ over: false }),
}));

vi.mock('@api/services/feature.service', () => ({
  featureService: {
    isFeatureEnabled: vi.fn().mockResolvedValue(true),
    getStoreFeatures: vi.fn(),
    getEnabledFeatureKeys: vi.fn().mockResolvedValue(['bundles']),
    invalidateCache: vi.fn(),
  },
}));
vi.mock('@api/middleware/auth', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticate: (_req: any, _res: any, next: any) => next(),
  authorize:
    (..._roles: string[]) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (_req: any, _res: any, next: any) =>
      next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature:
    (..._args: unknown[]) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (_req: any, _res: any, next: any) =>
      next(),
}));
vi.mock('@api/middleware/security', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeLimiter: (_req: any, _res: any, next: any) => next(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicTenantLimiter: (_req: any, _res: any, next: any) => next(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicLimiter: (_req: any, _res: any, next: any) => next(),
  auditLog:
    (..._args: unknown[]) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (_req: any, _res: any, next: any) =>
      next(),
}));
vi.mock('@api/lib/public-cache', () => ({
  invalidateStoreProductCaches: vi.fn().mockResolvedValue(undefined),
  bundlesCacheKey: (storeId: string) => `public:bundles:v2:${storeId}`,
  // #1565 wrapped the public bundle routes in getCached. Pass through as an
  // always-miss cache (call fetchFn, return its result) so this file's
  // per-request drift scenarios are observed on every call, not served stale
  // from a real cache the mock would otherwise need to model.
  getCached: vi.fn((_key: string, _ttl: number, fetchFn: () => unknown) => fetchFn()),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { CartService } from '@api/services/cart.service';
import { OrderService } from '@api/services/order.service';

let app: Express;

beforeAll(async () => {
  const { default: bundleRouter } = await import('@api/routes/bundle.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/api/v1/stores', bundleRouter);
  app.use(errorHandler);
});

/** Point every bundle read at the same box, priced from `componentPrice`. */
function withComponentPrice(componentPrice: number) {
  mockPrisma.bundle.findFirst.mockResolvedValue(bundleRow(componentPrice));
  mockPrisma.bundle.findMany.mockResolvedValue([{ id: BUNDLE_ID }]);
  mockPrisma.bundleItem.findMany.mockResolvedValue(BUNDLE_ITEM_ROWS);
  mockPrisma.cart.findFirst.mockResolvedValue(CART_ROW);
  mockPrisma.cart.update.mockResolvedValue(CART_ROW);
}

const ORDER_DATA = {
  shippingAddress: {
    firstName: 'Test',
    lastName: 'Customer',
    address1: '123 Test St',
    city: 'Cairo',
    state: 'Capital',
    postalCode: '12345',
    country: 'Egypt',
    phone: '+96500000000',
  },
  paymentMethod: 'cod',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.cartBundle.findFirst.mockResolvedValue(null);
  mockPrisma.product.findMany.mockResolvedValue([
    { id: 'p-dates', trackInventory: false, costPrice: null, categories: [] },
  ]);
  mockPrisma.store.findUnique.mockResolvedValue({ name: 'Test Store', settings: null });
  mockPrisma.taxRate.findMany.mockResolvedValue([]);
  mockPrisma.customer.findFirst.mockResolvedValue(null);
  mockPrisma.user.findUnique.mockResolvedValue(null);
  mockPrisma.promotion.findMany.mockResolvedValue([]);
  mockPrisma.coupon.findFirst.mockResolvedValue(null);
});

// ─── The storefront list ────────────────────────────────────────────────────

describe('GET /public/:storeId/bundles', () => {
  it('lists the bundle while its discount is smaller than its components', async () => {
    withComponentPrice(PRICE_BEFORE_DRIFT);

    const res = await request(app).get(`/api/v1/stores/public/${STORE_ID}/bundles`);

    expect(res.status).toBe(200);
    expect(res.body.data.bundles).toHaveLength(1);
    expect(res.body.data.bundles[0].price).toBe(PRICE_BEFORE_DRIFT - DISCOUNT_FILS);
  });

  it('drops it once the components drift below the discount — never advertises a 0 price', async () => {
    withComponentPrice(PRICE_AFTER_DRIFT);

    const res = await request(app).get(`/api/v1/stores/public/${STORE_ID}/bundles`);

    expect(res.status).toBe(200);
    expect(res.body.data.bundles).toEqual([]);
    // The whole point: a `{ price: 0 }` entry must never reach a shopper.
    expect(JSON.stringify(res.body)).not.toContain('"price":0');
  });
});

// ─── Add to cart ────────────────────────────────────────────────────────────

describe('CartService.addBundle', () => {
  it('adds the bundle while its discount is smaller than its components', async () => {
    withComponentPrice(PRICE_BEFORE_DRIFT);

    const result = await CartService.addBundle(STORE_ID, 'sess-1', BUNDLE_ID, 1);

    expect(result.ok).toBe(true);
    expect(mockPrisma.cartBundle.create).toHaveBeenCalled();
  });

  it('refuses it once the components drift below the discount, and writes nothing', async () => {
    withComponentPrice(PRICE_AFTER_DRIFT);

    const result = await CartService.addBundle(STORE_ID, 'sess-1', BUNDLE_ID, 1);

    expect(result).toEqual({ ok: false, error: 'bundle_not_purchasable' });
    expect(mockPrisma.cartBundle.create).not.toHaveBeenCalled();
    expect(mockPrisma.cartBundle.update).not.toHaveBeenCalled();
  });
});

// ─── Checkout ───────────────────────────────────────────────────────────────

describe('OrderService.create — the checkout recheck', () => {
  it('creates the order while the discount is smaller than the components', async () => {
    withComponentPrice(PRICE_BEFORE_DRIFT);

    const order = await OrderService.create(STORE_ID, undefined, 'sess-1', ORDER_DATA);

    expect(order).toBeTruthy();
  });

  it('refuses a box already in a cart once its components drift below the discount', async () => {
    // The dangerous window this closes: the customer added the box when it
    // was 15.000 and the merchant repriced the components afterwards. The
    // cart still holds the row; only the checkout recheck stands between
    // them and a free box of real goods.
    withComponentPrice(PRICE_AFTER_DRIFT);

    await expect(
      OrderService.create(STORE_ID, undefined, 'sess-1', ORDER_DATA)
    ).rejects.toMatchObject({ statusCode: 409, code: 'BUNDLE_NOT_PURCHASABLE' });
  });
});
