/**
 * P0-1 (final review): a coupon on a cart that contains a bundle must be
 * QUOTED against the same subtotal the order is CHARGED against.
 *
 * A bundle's price is already a discount, so `OrderService.create` evaluates
 * a coupon against `cart.items` only (Ruling B1 — no stacking on an
 * already-discounted box). The storefront, however, quoted the coupon
 * against `CartContext.total`, which now FOLDS IN the bundle. A bundle-only
 * cart therefore showed "-1.200 EGP" on the pay button and was charged the
 * full 12.000; a mixed cart was quoted 2.200 and charged with 1.000 applied.
 *
 * The assertion that would have caught it is the one below: quote the
 * coupon exactly the way the storefront now does, create the order, and
 * require the two numbers to be the same. Plus the min-order half — a
 * bundle-only cart must not PASS a coupon's minimum and then receive zero
 * discount from it.
 *
 * `CouponService` and the real allocation/pricing math run unmocked; only
 * Prisma, the cart, and the async fan-outs are stubbed (same style as
 * tests/unit/order.test.ts and tests/unit/coupon-validate-targeting-route.test.ts).
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const STORE_ID = '11111111-1111-1111-1111-111111111111';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Ramadan Box: components 7000 + 7500 = 14500, sold at a fixed 12000. */
const BUNDLE_ROW = {
  id: 'bundle-1',
  storeId: STORE_ID,
  name: 'Ramadan Box',
  nameAr: null,
  slug: 'ramadan-box',
  image: null,
  description: null,
  descriptionAr: null,
  pricingType: 'fixed_price',
  pricingValue: 12000,
  isActive: true,
  startsAt: null,
  expiresAt: null,
  items: [
    {
      id: 'bi-1',
      quantity: 1,
      variantId: null,
      product: {
        price: 7000,
        trackInventory: false,
        inventory: 0,
        variants: [],
        deletedAt: null,
        status: 'active',
      },
      variant: null,
    },
    {
      id: 'bi-2',
      quantity: 1,
      variantId: null,
      product: {
        price: 7500,
        trackInventory: false,
        inventory: 0,
        variants: [],
        deletedAt: null,
        status: 'active',
      },
      variant: null,
    },
  ],
};

const BUNDLE_ITEM_ROWS = [
  {
    id: 'bi-1',
    productId: 'p-dates',
    variantId: null,
    quantity: 1,
    product: { name: 'Dates', sku: 'D-1', costPrice: null, trackInventory: false },
  },
  {
    id: 'bi-2',
    productId: 'p-honey',
    variantId: null,
    quantity: 1,
    product: { name: 'Sidr Honey', sku: 'H-1', costPrice: null, trackInventory: false },
  },
];

const BUNDLE_PRICE = 12000;
/** One loose line used by the mixed-cart case: 5000 piastres x 2. */
const LOOSE_LINE = {
  id: 'ci-1',
  productId: 'p-loose',
  variantId: null,
  quantity: 2,
  product: { id: 'p-loose', name: 'Loose Tea', price: 5000, images: [], trackInventory: false },
  variant: null,
};
const LOOSE_SUBTOTAL = 10000;

function couponRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'coupon-1',
    storeId: STORE_ID,
    code: 'SAVE10',
    name: 'Save 10',
    nameAr: null,
    type: 'percentage',
    value: 10,
    minOrderAmount: null,
    maxDiscount: null,
    usageLimit: null,
    usageLimitPerUser: null,
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

// ─── Mocks ──────────────────────────────────────────────────────────────────

const { mockPrisma, capturedOrderCreate } = vi.hoisted(() => {
  const capturedOrderCreate = vi.fn();
  return {
    capturedOrderCreate,
    mockPrisma: {
      bundle: { findFirst: vi.fn() },
      bundleItem: { findMany: vi.fn() },
      coupon: { findFirst: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      $transaction: vi.fn(async (fn: any) => {
        if (typeof fn !== 'function') return fn;
        return fn({
          order: {
            create: vi.fn(async (args: unknown) => {
              capturedOrderCreate(args);
              return {
                id: 'order-1',
                orderNumber: 'ORD-1',
                storeId: STORE_ID,
                items: [],
                customer: null,
              };
            }),
            count: vi.fn().mockResolvedValue(0),
          },
          coupon: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
          product: { update: vi.fn(), findUnique: vi.fn() },
          productVariant: { update: vi.fn(), findUnique: vi.fn() },
          $queryRaw: vi.fn().mockResolvedValue([]),
          cartItem: {
            findMany: vi.fn(async () => cartRows.items),
            count: vi.fn(async () => cartSize.items),
            deleteMany: vi.fn(async () => ({ count: cartSize.items })),
          },
          cartBundle: {
            findMany: vi.fn(async () => cartRows.bundles),
            count: vi.fn(async () => cartSize.bundles),
            deleteMany: vi.fn(async () => ({ count: cartSize.bundles })),
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
  };
});

// Money batch B: fiscal documents + the frozen COD fee are covered end-to-end
// by tests/integration/fiscal-documents.test.ts; this unit suite stubs them.
vi.mock('@api/services/price-resolver.service', async () =>
  (await import('../helpers/retail-price-resolver')).retailPriceResolverModule()
);
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
  Prisma: {},
  OrderStatus: {},
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withStore: (_storeId: string, fn: any) => fn(mockPrisma),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withMoneyTx: (client: any, fn: any) =>
    client?.$transaction ? client.$transaction(fn) : fn(client),
}));

vi.mock('@api/services/cart.service', () => ({
  CartService: { getOrCreate: vi.fn() },
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
  // coupons/validate runs optionalAuthenticate (issue 2066): no token = guest.
  optionalAuthenticate: (_req: any, _res: any, next: any) => next(),
  customerUserId: () => undefined,
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
  couponValidateLimiter: (_req: any, _res: any, next: any) => next(),
  couponValidateDistinctLimiter: (_req: any, _res: any, next: any) => next(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicTenantLimiter: (_req: any, _res: any, next: any) => next(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { OrderService } from '@api/services/order.service';
import { ShippingService } from '@api/services/shipping.service';
import { AppError } from '@api/middleware/error-handler';
import { CartService } from '@api/services/cart.service';

// ─── Helpers ────────────────────────────────────────────────────────────────

let app: Express;

beforeAll(async () => {
  const { default: couponRouter } = await import('@api/routes/coupon.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/api/v1/stores', couponRouter);
  app.use(errorHandler);
});

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
  couponCode: 'SAVE10',
};

/** what the cart mock holds, read by the transaction's cart-claim mocks (row count under the lock, rows deleted) */
const cartSize = { items: 0, bundles: 0 };
const cartRows: { items: unknown[]; bundles: unknown[] } = { items: [], bundles: [] };
function setCart(looseItems: unknown[], bundleBoxes: number) {
  cartSize.items = looseItems.length;
  cartSize.bundles = bundleBoxes > 0 ? 1 : 0;
  cartRows.items = looseItems;
  cartRows.bundles =
    bundleBoxes > 0 ? [{ id: 'cb-1', bundleId: 'bundle-1', quantity: bundleBoxes }] : [];
  vi.mocked(CartService.getOrCreate).mockResolvedValue({
    id: 'cart-1',
    storeId: STORE_ID,
    sessionId: 'sess-1',
    customerId: undefined,
    items: looseItems,
    bundles: bundleBoxes > 0 ? [{ id: 'cb-1', bundleId: 'bundle-1', quantity: bundleBoxes }] : [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

/**
 * What the storefront asks for: the coupon quote the customer is shown on
 * the pay button, produced by the same public endpoint both `/cart` and
 * `/checkout` call.
 */
async function quoteDiscount(orderTotal: number): Promise<number> {
  const res = await request(app)
    .post(`/api/v1/stores/public/${STORE_ID}/coupons/validate`)
    .send({ code: 'SAVE10', orderTotal });
  expect(res.status).toBe(200);
  return res.body.data.discount as number;
}

/** What the customer is actually charged: the discount persisted on the order. */
async function chargedDiscount(): Promise<number> {
  capturedOrderCreate.mockClear();
  await OrderService.create(STORE_ID, undefined, 'sess-1', ORDER_DATA);
  const args = capturedOrderCreate.mock.calls.at(-1)?.[0] as {
    data: { couponDiscount: number };
  };
  return args.data.couponDiscount;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('coupon on a cart containing a bundle — quote must equal charge', () => {
  beforeEach(() => {
    // a failed shipping lookup is refused (T01-SHIP-1); these tests are about bundles, so the store has no zones: 0
    vi.spyOn(ShippingService, 'calculateShipping').mockResolvedValue({
      shippingCost: 0,
      freeShipping: false,
      matched: false,
      storeHasAreaRates: false,
    } as never);
    vi.clearAllMocks();
    mockPrisma.bundle.findFirst.mockResolvedValue(BUNDLE_ROW);
    mockPrisma.bundleItem.findMany.mockResolvedValue(BUNDLE_ITEM_ROWS);
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow());
    mockPrisma.product.findMany.mockResolvedValue([
      {
        id: 'p-loose',
        name: 'Loose Tea',
        nameAr: null,
        trackInventory: false,
        costPrice: null,
        _count: { variants: 0 },
        categories: [],
      },
    ]);
    mockPrisma.store.findUnique.mockResolvedValue({ name: 'Test Store', settings: null });
    mockPrisma.taxRate.findMany.mockResolvedValue([]);
    mockPrisma.customer.findFirst.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.promotion.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bundle-only cart: the quoted discount equals the discount the order is created with', async () => {
    setCart([], 1);

    // The storefront's basis is now the LOOSE-items subtotal — 0 for a
    // bundle-only cart — not `CartContext.total` (which is BUNDLE_PRICE).
    const quoted = await quoteDiscount(0);
    const charged = await chargedDiscount();

    expect(quoted).toBe(charged);
    expect(charged).toBe(0);
  });

  it('documents the defect: quoting against the bundle-inclusive total diverges from the charge', async () => {
    setCart([], 1);

    const quotedTheOldWay = await quoteDiscount(BUNDLE_PRICE);
    const charged = await chargedDiscount();

    // 1200 promised on the pay button, 0 actually applied — a 1.200 EGP
    // overcharge relative to the displayed total.
    expect(quotedTheOldWay).toBe(1200);
    expect(charged).toBe(0);
    expect(quotedTheOldWay).not.toBe(charged);
  });

  it('mixed cart: the quoted discount equals the discount the order is created with', async () => {
    setCart([LOOSE_LINE], 1);

    const quoted = await quoteDiscount(LOOSE_SUBTOTAL);
    const charged = await chargedDiscount();

    expect(quoted).toBe(charged);
    expect(charged).toBe(1000);
  });

  it('a bundle-only cart cannot pass a coupon minimum it only meets via the bundle', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({ minOrderAmount: 5000 }));
    setCart([], 1);

    // The box is worth 12000 — more than the 5000 minimum — but a coupon
    // discounts loose lines only, so accepting it here would create an order
    // that "qualified" for a coupon and then received nothing from it.
    await expect(OrderService.create(STORE_ID, undefined, 'sess-1', ORDER_DATA)).rejects.toThrow(
      /Minimum order amount/i
    );
  });

  it('the same coupon minimum is met once the loose lines alone reach it', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow({ minOrderAmount: 5000 }));
    setCart([LOOSE_LINE], 1);

    expect(await chargedDiscount()).toBe(1000);
  });

  // #193 (owner decision): VAT is levied AFTER discount. The mixed cart is
  // 22000 piastres of goods (10000 loose + 12000 box) with a 1000-piastres coupon, so
  // at 5% the tax is 5% of 21000 = 1050 — not 5% of 22000 = 1100 as before.
  it('a VAT store charges tax on the subtotal net of the discount', async () => {
    // resolveActiveTaxRate gates the charge on taxEnabled + the `tax`
    // feature too, since ruling M3-9 — an active rate row alone is no
    // longer enough (the global mock's `isFeatureEnabled` already
    // resolves true; only taxEnabled needs setting here).
    mockPrisma.store.findUnique.mockResolvedValue({
      name: 'Test Store',
      settings: null,
      taxEnabled: true,
    });
    mockPrisma.taxRate.findMany.mockResolvedValue([{ rate: 5 }]);
    // VAT is charged only under a VERIFIED tax profile (ruling TAX-2).
    mockPrisma.storeTaxProfile.findUnique.mockResolvedValue({
      status: 'verified',
      taxRegistrationNumber: '123456789',
      legalName: 'Test Store LLC',
    });
    setCart([LOOSE_LINE], 1);

    capturedOrderCreate.mockClear();
    await OrderService.create(STORE_ID, undefined, 'sess-1', ORDER_DATA);
    const { data } = capturedOrderCreate.mock.calls.at(-1)?.[0] as {
      data: { subtotal: number; discount: number; tax: number; total: number; shipping: number };
    };

    expect(data.subtotal).toBe(22000);
    expect(data.discount).toBe(1000);
    expect(data.tax).toBe(1050);
    expect(data.total).toBe(22000 - 1000 + 1050 + data.shipping);
  });

  it('a store with tax off is unchanged: no tax, with or without a discount', async () => {
    setCart([LOOSE_LINE], 1);

    capturedOrderCreate.mockClear();
    await OrderService.create(STORE_ID, undefined, 'sess-1', ORDER_DATA);
    const { data } = capturedOrderCreate.mock.calls.at(-1)?.[0] as { data: { tax: number } };

    expect(data.tax).toBe(0);
  });
});

/**
 * P2-3 (final review): the raw `BundleItem` rows are read AFTER
 * `resolveBundle` and BEFORE the order transaction, and a merchant PUT with
 * `items` deletes and recreates them with NEW ids. A save landing in that
 * window made the id join miss, and a non-null assertion turned it into a
 * TypeError — an unhandled 500 on checkout, in a code path that answers 409
 * for every other "the bundle moved under us" case. No money is written
 * either way; the difference is whether the customer gets an actionable
 * error or a crash.
 */
describe('a bundle edited mid-checkout is refused, not a 500', () => {
  beforeEach(() => {
    vi.spyOn(ShippingService, 'calculateShipping').mockResolvedValue({
      shippingCost: 0,
      freeShipping: false,
      matched: false,
      storeHasAreaRates: false,
    } as never);
    vi.clearAllMocks();
    mockPrisma.bundle.findFirst.mockResolvedValue(BUNDLE_ROW);
    mockPrisma.coupon.findFirst.mockResolvedValue(couponRow());
    mockPrisma.product.findMany.mockResolvedValue([]);
    mockPrisma.store.findUnique.mockResolvedValue({ name: 'Test Store', settings: null });
    mockPrisma.taxRate.findMany.mockResolvedValue([]);
    mockPrisma.customer.findFirst.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.promotion.findMany.mockResolvedValue([]);
    setCart([], 1);
  });

  it('answers 409 BUNDLE_NOT_PURCHASABLE when the component rows were re-minted', async () => {
    // The merchant's PUT landed between the two reads: same bundle, brand
    // new BundleItem ids, so the resolved lines join to nothing.
    mockPrisma.bundleItem.findMany.mockResolvedValue(
      BUNDLE_ITEM_ROWS.map(row => ({ ...row, id: `${row.id}-remade` }))
    );

    const err = await OrderService.create(STORE_ID, undefined, 'sess-1', {
      ...ORDER_DATA,
      couponCode: undefined,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).code).toBe('BUNDLE_NOT_PURCHASABLE');
    expect((err as Error).message).not.toMatch(/undefined|cannot read/i);
    expect(capturedOrderCreate).not.toHaveBeenCalled();
  });

  it('still creates the order when the rows are the ones resolveBundle saw', async () => {
    mockPrisma.bundleItem.findMany.mockResolvedValue(BUNDLE_ITEM_ROWS);

    await OrderService.create(STORE_ID, undefined, 'sess-1', {
      ...ORDER_DATA,
      couponCode: undefined,
    });

    expect(capturedOrderCreate).toHaveBeenCalled();
  });
});
