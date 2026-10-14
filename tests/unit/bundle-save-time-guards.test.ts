/**
 * P2-1, P2-2 and P2-5 (final review) — the three save-time guards on the
 * admin bundle routes, plus the read-order half of P2-1.
 *
 *  P2-1 — allocation is order-dependent (`allocateBundlePrice` breaks
 *         fractional-remainder ties by input index, and its residual rounds
 *         are order-sensitive), yet admin validated in REQUEST order while
 *         checkout validated in unspecified Postgres row order. Both now
 *         sort by the component's own identity, and the DB read carries an
 *         explicit `orderBy` so it is at least deterministic.
 *  P2-2 — `bundle_items` UNIQUE (bundle_id, product_id, variant_id) does not
 *         stop two rows for the same product with a NULL variant_id, because
 *         Postgres treats NULLs as distinct. `bundleAvailability` then reads
 *         each line independently and overstates how many boxes are makeable.
 *  P2-5 — `computeBundlePrice` silently clamps a `fixed_price` above the
 *         component sum, so a mistyped price was accepted and quietly
 *         overridden.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { compareBundleComponents, resolveBundle } from '../../apps/api/src/services/bundle.service';

const STORE_ID = '11111111-1111-1111-1111-111111111111';
const P_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const P_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const V_B1 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// ─── P2-1: the canonical order both sides use ───────────────────────────────

describe('compareBundleComponents', () => {
  it('orders by productId, then variantId, with a null variant first', () => {
    const rows = [
      { productId: P_B, variantId: V_B1 },
      { productId: P_B, variantId: null },
      { productId: P_A, variantId: null },
    ];
    expect([...rows].sort(compareBundleComponents)).toEqual([
      { productId: P_A, variantId: null },
      { productId: P_B, variantId: null },
      { productId: P_B, variantId: V_B1 },
    ]);
  });

  it('is a total order — the same input set sorts identically from any starting order', () => {
    const rows = [
      { productId: P_B, variantId: V_B1 },
      { productId: P_A, variantId: null },
      { productId: P_B, variantId: null },
    ];
    const forward = [...rows].sort(compareBundleComponents);
    const reversed = [...rows].reverse().sort(compareBundleComponents);
    expect(reversed).toEqual(forward);
  });
});

describe('resolveBundle read order', () => {
  const bundleRow = (items: unknown[]) => ({
    id: 'bundle-1',
    storeId: STORE_ID,
    name: 'Box',
    nameAr: null,
    slug: 'box',
    image: null,
    pricingType: 'fixed_price',
    pricingValue: 4000,
    isActive: true,
    startsAt: null,
    expiresAt: null,
    items,
  });
  // `include` returns every BundleItem scalar, so productId/variantId are on
  // the row the resolver sorts by.
  const component = (id: string, productId: string, quantity: number, price: number) => ({
    id,
    productId,
    quantity,
    variantId: null,
    variant: null,
    product: {
      price,
      trackInventory: false,
      inventory: 0,
      variants: [],
      deletedAt: null,
      status: 'active',
    },
  });

  it('asks Postgres for a deterministic row order', async () => {
    const findFirst = vi.fn().mockResolvedValue(bundleRow([component('i1', P_A, 1, 4000)]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await resolveBundle({ bundle: { findFirst } } as any, STORE_ID, 'bundle-1');

    const args = findFirst.mock.calls.at(-1)?.[0] as {
      include: { items: { orderBy: unknown } };
    };
    expect(args.include.items.orderBy).toEqual({ id: 'asc' });
  });

  it('produces the same lines whatever order the rows come back in', async () => {
    const rows = [component('i2', P_B, 2, 3000), component('i1', P_A, 1, 1000)];

    const resolveWith = async (items: unknown[]) => {
      const findFirst = vi.fn().mockResolvedValue(bundleRow(items));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return resolveBundle({ bundle: { findFirst } } as any, STORE_ID, 'bundle-1');
    };

    const a = await resolveWith(rows);
    const b = await resolveWith([...rows].reverse());
    expect(a.lines).toEqual(b.lines);
  });
});

// ─── The route surface (P2-2, P2-5) ─────────────────────────────────────────

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    product: { findMany: vi.fn() },
    bundle: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
    bundleItem: { findMany: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('@ebda/database', () => ({
  prisma: mockPrisma,
  Prisma: {},
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withMoneyTx: (client: any, fn: any) =>
    client?.$transaction ? client.$transaction(fn) : fn(client),
}));
vi.mock('@api/middleware/auth', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin' };
    next();
  },
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
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let app: Express;

beforeAll(async () => {
  const { default: bundleRouter } = await import('@api/routes/bundle.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/api/v1/stores', bundleRouter);
  app.use(errorHandler);
});

const body = (overrides: Record<string, unknown>) => ({
  name: 'Ramadan Box',
  slug: 'ramadan-box',
  pricingType: 'percentage',
  pricingValue: 1000,
  items: [{ productId: P_A, quantity: 1 }],
  ...overrides,
});

describe('POST /:storeId/bundles — duplicate components (P2-2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.product.findMany.mockResolvedValue([
      { id: P_A, name: 'Dates', price: 2500, variants: [] },
      { id: P_B, name: 'Honey', price: 3000, variants: [{ id: V_B1, price: 3200 }] },
    ]);
    mockPrisma.bundle.findFirst.mockResolvedValue(null);
  });

  it('rejects the same product listed twice with a null variantId', async () => {
    // Postgres's UNIQUE index does NOT catch this: NULLs compare distinct.
    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(
        body({
          items: [
            { productId: P_A, quantity: 4 },
            { productId: P_A, quantity: 4 },
          ],
        })
      );

    expect(res.status).toBe(400);
    expect(mockPrisma.bundle.create).not.toHaveBeenCalled();
    // The message must be in `error.message`, not only in `error.details`:
    // the error handler flattens a ZodError to "Invalid request data" and the
    // admin bundle editor renders `saveError.message` alone, so a
    // schema-refine-only rejection would tell the merchant nothing useful.
    expect(res.body.error.code).toBe('DUPLICATE_BUNDLE_COMPONENT');
    expect(res.body.error.message).toMatch(/appears twice/i);
    expect(res.body.error.message).not.toBe('Invalid request data');
    // P2-e: names the product, not its uuid — the merchant sees named rows
    // in the editor and has no way to match a raw id back to one.
    expect(res.body.error.message).toContain('Dates');
    expect(res.body.error.message).not.toContain(P_A);
  });

  it('rejects the same product/variant pair listed twice', async () => {
    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(
        body({
          items: [
            { productId: P_B, variantId: V_B1, quantity: 1 },
            { productId: P_B, variantId: V_B1, quantity: 2 },
          ],
        })
      );

    expect(res.status).toBe(400);
  });

  it('still allows the same product across two DIFFERENT variants', async () => {
    mockPrisma.product.findMany.mockResolvedValue([
      {
        id: P_B,
        price: 3000,
        variants: [
          { id: V_B1, price: 3200 },
          { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', price: 3400 },
        ],
      },
    ]);

    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(
        body({
          items: [
            { productId: P_B, variantId: V_B1, quantity: 1 },
            {
              productId: P_B,
              variantId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
              quantity: 1,
            },
          ],
        })
      );

    expect(res.status).not.toBe(400);
  });

  it('the same guard is on update, not just create', async () => {
    mockPrisma.bundle.findFirst.mockResolvedValue({
      id: 'bundle-1',
      storeId: STORE_ID,
      pricingType: 'percentage',
      pricingValue: 1000,
      items: [],
    });

    const res = await request(app)
      .put(`/api/v1/stores/${STORE_ID}/bundles/bundle-1`)
      .send({
        items: [
          { productId: P_A, quantity: 4 },
          { productId: P_A, quantity: 4 },
        ],
      });

    expect(res.status).toBe(400);
  });
});

describe('POST /:storeId/bundles — fixed_price above the component sum (P2-5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // One component at 14500 piastres.
    mockPrisma.product.findMany.mockResolvedValue([{ id: P_A, price: 14500, variants: [] }]);
    mockPrisma.bundle.findFirst.mockResolvedValue(null);
  });

  it('rejects a price the merchant typed that is higher than the components', async () => {
    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(body({ pricingType: 'fixed_price', pricingValue: 15000 }));

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PRICE_ABOVE_COMPONENT_SUM');
    // The merchant is told what the ceiling actually is.
    expect(res.body.error.details).toEqual({ componentSum: 14500 });
    expect(mockPrisma.bundle.create).not.toHaveBeenCalled();
  });

  it('accepts a price exactly equal to the component sum', async () => {
    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(body({ pricingType: 'fixed_price', pricingValue: 14500 }));

    expect(res.status).not.toBe(422);
  });

  it('accepts a genuine discount', async () => {
    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(body({ pricingType: 'fixed_price', pricingValue: 12000 }));

    expect(res.status).not.toBe(422);
  });

  it('leaves the percentage case to its existing basis-points guard', async () => {
    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(body({ pricingType: 'percentage', pricingValue: 50000 }));

    // P2-d (scoped re-review): this guard moved from a Zod refine (flattened
    // by errorHandler to a generic "Invalid request data", which the admin
    // editor never renders) to a 422 AppError, the same shape as the
    // sibling `PRICE_ABOVE_COMPONENT_SUM` guard above — so the actionable
    // "basis points…" text reaches `res.body.error.message`, not just
    // `details`.
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PRICING_VALUE_OUT_OF_RANGE');
    expect(res.body.error.message).toMatch(/basis points/i);
    expect(res.body.error.message).not.toBe('Invalid request data');
  });
});

describe('POST/PUT /:storeId/bundles — a `fixed` discount that swallows the components (P1)', () => {
  // The third `BundlePricingType` member. `assertPricingValueInRange` covered
  // 'percentage' and `assertPriceWithinComponentSum` covered 'fixed_price';
  // 'fixed' (piastres OFF the component sum) was covered by neither, so
  // `computeBundlePrice`'s `Math.max(0, componentSum - pricingValue)` clamp
  // silently accepted a discount worth more than the whole kit and sold the
  // box for 0 — while the semantically identical `fixed_price: 15000` on the
  // same components was correctly rejected.
  beforeEach(() => {
    vi.clearAllMocks();
    // One component at 14500 piastres — the same kit the `fixed_price` block above
    // uses, so the two rejections are directly comparable.
    mockPrisma.product.findMany.mockResolvedValue([{ id: P_A, price: 14500, variants: [] }]);
    mockPrisma.bundle.findFirst.mockResolvedValue(null);
  });

  it('rejects a discount larger than the components — the same 422 as the identical fixed_price', async () => {
    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(body({ pricingType: 'fixed', pricingValue: 20000 }));

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PRICE_ABOVE_COMPONENT_SUM');
    // The merchant is told what the ceiling actually is, same as fixed_price.
    expect(res.body.error.details).toEqual({ componentSum: 14500 });
    // ...and told which knob to turn: the text names the DISCOUNT, not a
    // "price" field this form does not have when the type is 'fixed'.
    expect(res.body.error.message).toMatch(/discount/i);
    expect(res.body.error.message).not.toBe('Invalid request data');
    expect(mockPrisma.bundle.create).not.toHaveBeenCalled();
  });

  it('rejects a discount worth EXACTLY the components — 100% off is a free box, not a discount', async () => {
    // Unlike `fixed_price`, where value === componentSum is a legitimate
    // zero-discount price, a `fixed` value === componentSum leaves 0.
    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(body({ pricingType: 'fixed', pricingValue: 14500 }));

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PRICE_ABOVE_COMPONENT_SUM');
    expect(mockPrisma.bundle.create).not.toHaveBeenCalled();
  });

  it('accepts a genuine amount-off discount', async () => {
    mockPrisma.bundle.create.mockResolvedValue({ id: 'bundle-1' });
    mockPrisma.bundle.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(body({ pricingType: 'fixed', pricingValue: 2500 }));

    expect(res.status).not.toBe(422);
    expect(mockPrisma.bundle.create).toHaveBeenCalled();
  });

  it('accepts a discount one fil below the components — the boundary is `>=`, not `>`', async () => {
    mockPrisma.bundle.create.mockResolvedValue({ id: 'bundle-1' });
    mockPrisma.bundle.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(body({ pricingType: 'fixed', pricingValue: 14499 }));

    expect(res.status).not.toBe(422);
  });

  it('the same guard is on update, not just create', async () => {
    mockPrisma.bundle.findFirst.mockResolvedValue({
      id: 'bundle-1',
      storeId: STORE_ID,
      pricingType: 'fixed',
      pricingValue: 2500,
      items: [{ productId: P_A, variantId: null, quantity: 1 }],
    });

    const res = await request(app)
      .put(`/api/v1/stores/${STORE_ID}/bundles/bundle-1`)
      .send({ pricingValue: 20000 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PRICE_ABOVE_COMPONENT_SUM');
  });

  it('the update guard reads the STORED pricingType when the request only moves the value', async () => {
    // The PUT merges `data.pricingType ?? existing.pricingType`; a merchant
    // editing only the number must be checked against the rule the bundle
    // already has, not against a default.
    mockPrisma.bundle.findFirst.mockResolvedValue({
      id: 'bundle-1',
      storeId: STORE_ID,
      pricingType: 'fixed',
      pricingValue: 2500,
      items: [{ productId: P_A, variantId: null, quantity: 1 }],
    });

    const res = await request(app)
      .put(`/api/v1/stores/${STORE_ID}/bundles/bundle-1`)
      .send({ pricingValue: 14500 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PRICE_ABOVE_COMPONENT_SUM');
  });
});

// ─── P2-b: save-time/read-time agreement on a fractional-remainder tie ─────
//
// `allocateBundlePrice` breaks a fractional-remainder tie by the ORIGINAL
// INDEX of the line in the array it is given (see bundle-pricing.ts). Two
// components at unitPrice 100 piastres, quantities 2 and 3, and a bundle price
// of 499 (componentSum 500) produce an EXACT tie: reordering the two lines
// flips `isAllocatable` from true to false. `resolveBundleLines`' canonical
// (productId, variantId) sort is what stops the admin route from seeing a
// different order than checkout's `resolveBundle` ever would — this test
// fails without that sort, even though every OTHER guard in this file stays
// green (P2-b in `bundles-rereview.md`: the sort had no test that would
// redden if deleted).
describe('POST /:storeId/bundles — fractional-remainder tie agrees with checkout order (P2-b)', () => {
  // productId "aaaa…" < "cccc…" lexicographically, so the canonical
  // (productId, variantId) order — the SAME order `resolveBundle` reads at
  // checkout — is [P_LOW (qty 3), P_HIGH (qty 2)].
  const P_LOW = 'aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const P_HIGH = 'cccc2222-cccc-cccc-cccc-cccccccccccc';
  const BUNDLE_PRICE = 499; // fixed_price; componentSum is 500

  // What `resolveBundle` (checkout's own reader) sees if the bundle DOES
  // get created — used so a save-time bug that wrongly ACCEPTS this price
  // can be told apart from a correct REJECT by status code (201 vs 422),
  // not just "some error occurred".
  const persistedBundleRow = {
    id: 'bundle-499',
    storeId: STORE_ID,
    name: 'Ramadan Box',
    nameAr: null,
    slug: 'ramadan-box',
    image: null,
    pricingType: 'fixed_price',
    pricingValue: BUNDLE_PRICE,
    isActive: true,
    startsAt: null,
    expiresAt: null,
    items: [P_HIGH, P_LOW].map((productId, i) => ({
      id: `bi-${i}`,
      productId,
      quantity: productId === P_HIGH ? 2 : 3,
      variantId: null,
      variant: null,
      product: {
        price: 100,
        trackInventory: false,
        inventory: 0,
        variants: [],
        deletedAt: null,
        status: 'active',
      },
    })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.product.findMany.mockResolvedValue([
      { id: P_LOW, price: 100, variants: [] },
      { id: P_HIGH, price: 100, variants: [] },
    ]);
    // Only reached if the (buggy, unsorted) save path wrongly finds the
    // price allocatable and proceeds to create + resolveBundle's own read.
    mockPrisma.bundle.create.mockResolvedValue({ id: persistedBundleRow.id });
    mockPrisma.bundle.findFirst.mockResolvedValue(persistedBundleRow);
  });

  // Verifies the fixture actually exercises a tie, independent of the
  // route: the canonical checkout order (low id first, qty 3 then qty 2)
  // is NOT allocatable at 499, but the reverse (high id first, qty 2 then
  // qty 3) IS — same components, same price, order is the only variable.
  it('sanity: the fixture is a genuine order-flip at the bundle-pricing level', async () => {
    const { isAllocatable } = await import('@ebda/shared');
    const checkoutOrder = [
      { key: 'low', unitPrice: 100, quantity: 3 },
      { key: 'high', unitPrice: 100, quantity: 2 },
    ];
    const reversedOrder = [
      { key: 'high', unitPrice: 100, quantity: 2 },
      { key: 'low', unitPrice: 100, quantity: 3 },
    ];
    expect(isAllocatable(checkoutOrder, BUNDLE_PRICE)).toBe(false);
    expect(isAllocatable(reversedOrder, BUNDLE_PRICE)).toBe(true);
  });

  it('rejects the price at save time the SAME way checkout would — regardless of the order the merchant listed the components in', async () => {
    // The merchant lists the HIGH-id component (qty 2) first — the order
    // that, unsorted, reads as allocatable (the dangerous direction: admin
    // would say "fine" while checkout's canonical order later 409s).
    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(
        body({
          pricingType: 'fixed_price',
          pricingValue: BUNDLE_PRICE,
          items: [
            { productId: P_HIGH, quantity: 2 },
            { productId: P_LOW, quantity: 3 },
          ],
        })
      );

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PRICE_NOT_ALLOCATABLE');
    expect(mockPrisma.bundle.create).not.toHaveBeenCalled();
  });

  it('agrees whichever order the merchant listed the components in', async () => {
    const dangerous = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(
        body({
          pricingType: 'fixed_price',
          pricingValue: BUNDLE_PRICE,
          items: [
            { productId: P_HIGH, quantity: 2 },
            { productId: P_LOW, quantity: 3 },
          ],
        })
      );
    const canonical = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(
        body({
          pricingType: 'fixed_price',
          pricingValue: BUNDLE_PRICE,
          items: [
            { productId: P_LOW, quantity: 3 },
            { productId: P_HIGH, quantity: 2 },
          ],
        })
      );

    expect(dangerous.status).toBe(canonical.status);
    expect(dangerous.body.error?.code).toBe(canonical.body.error?.code);
  });
});
