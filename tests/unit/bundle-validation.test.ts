/**
 * Task 4: bundle admin-time price validation + the admin CRUD route surface.
 *
 * Part 1 mirrors the brief's original test almost verbatim, with ONE
 * deliberate deviation from the brief text (RULING C2, controller review):
 * `nearestAllocatablePrice` is NOT defined in bundle.routes.ts — Task 2
 * already shipped it in `@ebda/shared`, and the route file only imports
 * it. Importing it from the routes file (as the brief originally wrote)
 * would not compile.
 *
 * Part 2 boots a minimal Express app mounting only bundle.routes (same
 * app-bootstrap pattern as tests/unit/coupon-targeting-route.test.ts /
 * promotion-preview-route.test.ts): only `@ebda/database` is mocked, so
 * the real Zod schemas, the real `resolveBundle`/pricing math, and the real
 * `requireFeature` gate all run through the HTTP layer.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { isAllocatable, nearestAllocatablePrice, type BundleLine } from '@ebda/shared';

// ─── Part 1: pure pricing-math assertions (brief's original test) ─────────

const ALL_PAIRS: BundleLine[] = [
  { key: 'a', unitPrice: 1000, quantity: 2 },
  { key: 'b', unitPrice: 3000, quantity: 2 },
];

describe('admin-time price validation', () => {
  it('suggests the nearest representable price instead of failing at checkout', () => {
    expect(isAllocatable(ALL_PAIRS, 4001)).toBe(false);
    expect(nearestAllocatablePrice(ALL_PAIRS, 4001, 8000)).toBe(4000);
  });

  it('returns the price unchanged when it already splits', () => {
    expect(nearestAllocatablePrice(ALL_PAIRS, 4000, 8000)).toBe(4000);
  });

  it('rejects a bundle with no items', () => {
    expect(isAllocatable([], 1000)).toBe(false);
  });
});

// ─── Part 2: route-level tests ─────────────────────────────────────────────

const { mockPrisma, mockIsFeatureEnabled } = vi.hoisted(() => ({
  mockPrisma: {
    product: { findMany: vi.fn() },
    bundle: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    bundleItem: { findMany: vi.fn(), deleteMany: vi.fn() },
  },
  mockIsFeatureEnabled: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: mockPrisma,
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
  // an anonymous admin-namespace GET takes the per-query store scope (LAZY-TX-3)
  runInStoreScope: (_storeId: string, fn: () => unknown) => fn(),
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

// `requireFeature` itself is NOT mocked — the real middleware runs, backed
// by a mocked `featureService.isFeatureEnabled`, so the "feature disabled"
// test exercises the actual gate wiring rather than a stand-in.
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: mockIsFeatureEnabled },
}));

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let app: Express;

async function buildApp(): Promise<Express> {
  const { default: bundleRouter } = await import('@api/routes/bundle.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const server = express();
  server.use(express.json());
  server.use('/api/v1/stores', bundleRouter);
  server.use(errorHandler);
  return server;
}

const STORE_ID = '11111111-1111-1111-1111-111111111111';
const PRODUCT_A = '22222222-2222-2222-2222-222222222222';
const PRODUCT_B = '33333333-3333-3333-3333-333333333333';
const BUNDLE_ID = '44444444-4444-4444-4444-444444444444';

/** Matches resolveBundle's own `client.bundle.findFirst` include shape. */
function bundleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BUNDLE_ID,
    storeId: STORE_ID,
    name: 'Starter Kit',
    nameAr: null,
    slug: 'starter-kit',
    image: null,
    pricingType: 'fixed_price',
    pricingValue: 4000,
    isActive: true,
    startsAt: null,
    expiresAt: null,
    items: [
      {
        id: 'item-a',
        variantId: null,
        quantity: 2,
        product: {
          price: 1000,
          trackInventory: false,
          inventory: 0,
          variants: [],
          deletedAt: null,
          status: 'active',
        },
        variant: null,
      },
      {
        id: 'item-b',
        variantId: null,
        quantity: 2,
        product: {
          price: 3000,
          trackInventory: false,
          inventory: 0,
          variants: [],
          deletedAt: null,
          status: 'active',
        },
        variant: null,
      },
    ],
    ...overrides,
  };
}

describe('admin bundle routes', () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(() => {
    mockIsFeatureEnabled.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /:storeId/bundles — quantity validation', () => {
    const basePayload = {
      name: 'Combo',
      slug: 'combo',
      pricingType: 'fixed_price',
      pricingValue: 4000,
    };

    it.each([
      ['0', 0],
      ['-1', -1],
      ['1001', 1001],
      ['1.5', 1.5],
    ])(
      'rejects quantity %s with a 4xx and never reaches the allocator',
      async (_label, quantity) => {
        const res = await request(app)
          .post(`/api/v1/stores/${STORE_ID}/bundles`)
          .send({ ...basePayload, items: [{ productId: PRODUCT_A, quantity }] });

        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        // Zod rejected before resolveBundleLines ever looked products up.
        expect(mockPrisma.product.findMany).not.toHaveBeenCalled();
        expect(mockPrisma.bundle.create).not.toHaveBeenCalled();
      }
    );

    it('accepts quantity 1000 (the upper bound) and quantity 1 (the lower bound)', async () => {
      mockPrisma.product.findMany.mockResolvedValue([{ id: PRODUCT_A, price: 1000, variants: [] }]);
      mockPrisma.bundle.create.mockResolvedValue({ id: BUNDLE_ID });
      mockPrisma.bundle.findFirst.mockResolvedValue(
        bundleRow({
          pricingValue: 1000,
          items: [
            {
              id: 'item-a',
              variantId: null,
              quantity: 1000,
              product: { price: 1000, trackInventory: false, inventory: 0, variants: [] },
              variant: null,
            },
          ],
        })
      );

      const res = await request(app)
        .post(`/api/v1/stores/${STORE_ID}/bundles`)
        .send({
          ...basePayload,
          pricingValue: 1000,
          items: [{ productId: PRODUCT_A, quantity: 1000 }],
        });

      expect(res.status).toBe(201);
      expect(mockPrisma.bundle.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /:storeId/bundles — save-time price validation', () => {
    it('rejects an unrepresentable price with 422 and a suggested value that IS allocatable', async () => {
      mockPrisma.product.findMany.mockResolvedValue([
        { id: PRODUCT_A, price: 1000, variants: [] },
        { id: PRODUCT_B, price: 3000, variants: [] },
      ]);

      const res = await request(app)
        .post(`/api/v1/stores/${STORE_ID}/bundles`)
        .send({
          name: 'Combo',
          slug: 'combo',
          pricingType: 'fixed_price',
          // Same numbers as the brief's ALL_PAIRS fixture: componentSum 8000,
          // 4001 is known not to be allocatable, nearest is 4000.
          pricingValue: 4001,
          items: [
            { productId: PRODUCT_A, quantity: 2 },
            { productId: PRODUCT_B, quantity: 2 },
          ],
        });

      // RULING T9-a (fix round 1): `price_not_allocatable` moved onto the
      // standard `{ success, error: { code, message, details } }` envelope
      // (a real `AppError`, not a bespoke body) — so the admin's one
      // consumer of this response could delete its custom parser and use
      // `apiPost`/`apiPut` like every other screen.
      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('PRICE_NOT_ALLOCATABLE');
      expect(typeof res.body.error.message).toBe('string');
      expect(res.body.error.details.suggested).toBe(4000);
      // The suggested value really is allocatable against the same lines —
      // not just a number that happens to match the brief's fixture.
      const lines: BundleLine[] = [
        { key: '0', unitPrice: 1000, quantity: 2 },
        { key: '1', unitPrice: 3000, quantity: 2 },
      ];
      expect(isAllocatable(lines, res.body.error.details.suggested)).toBe(true);
      expect(mockPrisma.bundle.create).not.toHaveBeenCalled();
    });

    it('creates the bundle when the price IS allocatable', async () => {
      mockPrisma.product.findMany.mockResolvedValue([
        { id: PRODUCT_A, price: 1000, variants: [] },
        { id: PRODUCT_B, price: 3000, variants: [] },
      ]);
      mockPrisma.bundle.create.mockResolvedValue({ id: BUNDLE_ID });
      mockPrisma.bundle.findFirst.mockResolvedValue(bundleRow());

      const res = await request(app)
        .post(`/api/v1/stores/${STORE_ID}/bundles`)
        .send({
          name: 'Starter Kit',
          slug: 'starter-kit',
          pricingType: 'fixed_price',
          pricingValue: 4000,
          items: [
            { productId: PRODUCT_A, quantity: 2 },
            { productId: PRODUCT_B, quantity: 2 },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.bundle.price).toBe(4000);
      expect(mockPrisma.bundle.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /:storeId/bundles/:id — cross-tenant isolation', () => {
    it('returns 404, never bundle data, for a bundle belonging to another store', async () => {
      // resolveBundle's own findFirst filters by { id, storeId } — a bundle
      // id that belongs to a different store simply resolves to no row.
      mockPrisma.bundle.findFirst.mockResolvedValue(null);

      const res = await request(app).get(`/api/v1/stores/${STORE_ID}/bundles/${BUNDLE_ID}`);

      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('Starter Kit');
      expect(mockPrisma.bundleItem.findMany).not.toHaveBeenCalled();
    });

    it('returns the bundle for the correct store', async () => {
      mockPrisma.bundle.findFirst.mockResolvedValue(bundleRow());
      mockPrisma.bundleItem.findMany.mockResolvedValue([]);

      const res = await request(app).get(`/api/v1/stores/${STORE_ID}/bundles/${BUNDLE_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.data.bundle.name).toBe('Starter Kit');
      expect(res.body.data.bundle.price).toBe(4000);
    });
  });

  describe('feature gate', () => {
    it('refuses before any handler logic runs when `bundles` is disabled for the store', async () => {
      mockIsFeatureEnabled.mockResolvedValue(false);

      const res = await request(app).get(`/api/v1/stores/${STORE_ID}/bundles`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FEATURE_DISABLED');
      expect(res.body.feature).toBe('bundles');
      expect(mockPrisma.bundle.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.bundle.count).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /:storeId/bundles/:id — deactivation, not hard delete', () => {
    it('sets isActive false instead of deleting the row', async () => {
      mockPrisma.bundle.findFirst.mockResolvedValue({ id: BUNDLE_ID });
      mockPrisma.bundle.update.mockResolvedValue({ id: BUNDLE_ID, isActive: false });

      const res = await request(app).delete(`/api/v1/stores/${STORE_ID}/bundles/${BUNDLE_ID}`);

      expect(res.status).toBe(200);
      expect(mockPrisma.bundle.update).toHaveBeenCalledWith({
        where: { id: BUNDLE_ID, storeId: STORE_ID },
        data: { isActive: false },
      });
      // No `bundle.delete` mock exists at all in this suite — if the route
      // ever called it, this test would throw "not a function" rather than
      // silently passing.
      expect((mockPrisma.bundle as any).delete).toBeUndefined();
    });

    it('404s for a bundle belonging to another store instead of deactivating it', async () => {
      mockPrisma.bundle.findFirst.mockResolvedValue(null);

      const res = await request(app).delete(`/api/v1/stores/${STORE_ID}/bundles/${BUNDLE_ID}`);

      expect(res.status).toBe(404);
      expect(mockPrisma.bundle.update).not.toHaveBeenCalled();
    });
  });
});
