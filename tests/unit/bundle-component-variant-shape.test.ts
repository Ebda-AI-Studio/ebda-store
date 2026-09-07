/**
 * P1-3 (final review): a bundle component on a VARIANT product that pins no
 * variant is an unsellable shape.
 *
 * `products.inventory` is unused (and stays 0) once a product has variants —
 * the real stock lives on the variant rows (see
 * `apps/api/src/lib/effective-inventory.ts`). A component line with a null
 * `variantId` on such a product reports availability from the variant SUM
 * and then decrements the PARENT column at checkout: the variant stock never
 * moves, the variants stay "in stock", and the merchant oversells them.
 *
 * Both halves are asserted here:
 *   (a) write time — a direct `POST /stores/:storeId/bundles` is rejected;
 *       the admin `BundleItemPicker` already forces the choice, nothing on
 *       the server did.
 *   (b) read time — the realistic case, needing no API abuse: a SIMPLE
 *       product is bundled and LATER gains variants. That row already
 *       exists, so it must fail closed on `isPurchasable` rather than sell.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { resolveBundle } from '../../apps/api/src/services/bundle.service';

const STORE_ID = '11111111-1111-1111-1111-111111111111';
const VARIANT_PRODUCT_ID = '22222222-2222-2222-2222-222222222222';
const SIMPLE_PRODUCT_ID = '33333333-3333-3333-3333-333333333333';
const VARIANT_ID = '44444444-4444-4444-4444-444444444444';
const MISSING_VARIANT_ID = '55555555-5555-5555-5555-555555555555';
const FOREIGN_PRODUCT_ID = '66666666-6666-6666-6666-666666666666';

// ─── (b) read time: a bundled simple product that later gains variants ──────

/**
 * The row `resolveBundle` reads. `productVariants` is what the product's
 * `variants` select returns — empty while the product is simple, populated
 * once the merchant adds a size option.
 */
const bundleRow = (productVariants: Array<{ inventory: number }>) => ({
  id: 'bundle-1',
  storeId: STORE_ID,
  name: 'Ramadan Box',
  nameAr: null,
  slug: 'ramadan-box',
  image: null,
  pricingType: 'fixed_price',
  pricingValue: 1000,
  isActive: true,
  startsAt: null,
  expiresAt: null,
  items: [
    {
      id: 'item-1',
      quantity: 1,
      // The bundle was created while the product was simple, so nothing is
      // pinned — and nothing later goes back and pins one.
      variantId: null,
      variant: null,
      product: {
        price: 1000,
        trackInventory: true,
        // Stale: a variant product's own column is never written again.
        inventory: 50,
        variants: productVariants,
        deletedAt: null,
        status: 'active',
      },
    },
  ],
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeClient = (row: unknown) =>
  ({ bundle: { findFirst: vi.fn().mockResolvedValue(row) } }) as any;

describe('a bundled product that gains variants after the fact', () => {
  it('is purchasable while the product is genuinely simple', async () => {
    const resolved = await resolveBundle(makeClient(bundleRow([])), STORE_ID, 'bundle-1');
    expect(resolved.isPurchasable).toBe(true);
  });

  it('stops being purchasable the moment the product gains variants', async () => {
    const resolved = await resolveBundle(
      makeClient(bundleRow([{ inventory: 20 }, { inventory: 10 }])),
      STORE_ID,
      'bundle-1'
    );

    // Availability still LOOKS fine — `effectiveInventory` reads the variant
    // sum (30) for a line with no pinned variant — which is exactly why the
    // gate has to be on the shape, not on the number.
    expect(resolved.available).toBeGreaterThan(0);
    expect(resolved.isPurchasable).toBe(false);
  });

  it('a pinned variant on the same product stays purchasable', async () => {
    const row = bundleRow([{ inventory: 20 }]);
    row.items[0].variantId = VARIANT_ID as never;
    row.items[0].variant = { price: 1000, inventory: 20, isActive: true } as never;

    const resolved = await resolveBundle(makeClient(row), STORE_ID, 'bundle-1');
    expect(resolved.isPurchasable).toBe(true);
  });
});

// ─── (a) write time: the route rejects the shape ────────────────────────────

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    product: { findMany: vi.fn() },
    bundle: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
    bundleItem: { createMany: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('@force/database', () => ({
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

const createBody = (items: Array<Record<string, unknown>>) => ({
  name: 'Ramadan Box',
  slug: 'ramadan-box',
  pricingType: 'percentage' as const,
  pricingValue: 1000,
  items,
});

describe('POST /:storeId/bundles — a variant product must pin a variant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.product.findMany.mockResolvedValue([
      {
        id: VARIANT_PRODUCT_ID,
        name: 'T-Shirt',
        price: 1000,
        variants: [{ id: VARIANT_ID, price: 1200 }],
      },
      { id: SIMPLE_PRODUCT_ID, name: 'Mug', price: 2000, variants: [] },
    ]);
    mockPrisma.bundle.findFirst.mockResolvedValue(null);
  });

  it('rejects a component on a variant product with no variantId', async () => {
    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(createBody([{ productId: VARIANT_PRODUCT_ID, quantity: 1 }]));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VARIANT_REQUIRED');
    expect(mockPrisma.bundle.create).not.toHaveBeenCalled();
    // P2-e: names the product, not its uuid.
    expect(res.body.error.message).toContain('T-Shirt');
    expect(res.body.error.message).not.toContain(VARIANT_PRODUCT_ID);
  });

  it('names the product, not its uuid, when the pinned variant is gone', async () => {
    // Same class as P2-e: `product` is resolved by the time INVALID_VARIANT
    // throws, so the merchant must see which of their named rows is wrong.
    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(
        createBody([{ productId: VARIANT_PRODUCT_ID, variantId: MISSING_VARIANT_ID, quantity: 1 }])
      );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_VARIANT');
    expect(res.body.error.message).toContain('T-Shirt');
    expect(mockPrisma.bundle.create).not.toHaveBeenCalled();
  });

  it('says plainly what is wrong when the product is not in the catalogue', async () => {
    // INVALID_PRODUCT is the one case with no name to print — the lookup is
    // what failed — so it must at least say what the merchant should DO.
    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(createBody([{ productId: FOREIGN_PRODUCT_ID, quantity: 1 }]));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PRODUCT');
    expect(res.body.error.message).toMatch(/not in this store's catalogue/);
    expect(res.body.error.message).toContain('remove it from the bundle');
    expect(mockPrisma.bundle.create).not.toHaveBeenCalled();
  });

  it('rejects it even when a valid simple component is alongside it', async () => {
    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(
        createBody([
          { productId: SIMPLE_PRODUCT_ID, quantity: 1 },
          { productId: VARIANT_PRODUCT_ID, quantity: 2 },
        ])
      );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VARIANT_REQUIRED');
  });

  it('accepts a component on a variant product that DOES pin a variant', async () => {
    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(createBody([{ productId: VARIANT_PRODUCT_ID, variantId: VARIANT_ID, quantity: 1 }]));

    expect(res.status).not.toBe(400);
  });

  it('still accepts a component on a genuinely simple product with no variantId', async () => {
    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/bundles`)
      .send(createBody([{ productId: SIMPLE_PRODUCT_ID, quantity: 1 }]));

    expect(res.status).not.toBe(400);
  });
});
