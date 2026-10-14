/**
 * Route-level tests for `GET /public/:storeId/bundles` (#1553, #1565).
 *
 * #1553 — the candidate query had no `take`, so an unbounded number of rows
 * could each fan out into its own `resolveBundle` call.
 * #1565 — the handler queried Prisma on every request, unlike every sibling
 * public list endpoint (products, categories), which go through
 * `getCached`. Proven here by counting `prisma.bundle.findMany` calls
 * across two requests for the same store: it must be ONE, not two — a
 * measured DB-hit reduction, not a claim.
 *
 * App-bootstrap pattern matches tests/unit/coupon-validate-targeting-route.test.ts.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const { mockPrisma, redisMock } = vi.hoisted(() => ({
  mockPrisma: {
    bundle: { findMany: vi.fn(), findFirst: vi.fn() },
  },
  redisMock: {
    get: vi.fn(async () => null as unknown),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    deleteByPattern: vi.fn(async () => 0),
    // FIX-001/002: healthy Redis with generations that never move.
    isAvailable: vi.fn(() => true),
    getCacheGenerations: vi.fn(async (names: string[]) => names.map(() => null)),
    bumpCacheGeneration: vi.fn(async () => {}),
  },
}));

vi.mock('@ebda/database', () => ({
  prisma: mockPrisma,
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
}));

vi.mock('@api/services/redis.service', () => ({ redis: redisMock }));

vi.mock('@api/middleware/tenant-context', () => ({
  tenantContext: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/middleware/auth', () => ({
  authenticate: (_req: any, _res: any, next: any) => next(),
  authorize:
    (..._roles: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));

vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature:
    (..._args: unknown[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));

vi.mock('@api/middleware/security', () => ({
  publicLimiter: (_req: any, _res: any, next: any) => next(),
  publicTenantLimiter: (_req: any, _res: any, next: any) => next(),
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

function bundleRow(id: string) {
  return {
    id,
    storeId: STORE_ID,
    name: `Box ${id}`,
    nameAr: null,
    slug: `box-${id}`,
    image: null,
    pricingType: 'fixed_price',
    pricingValue: 4000,
    isActive: true,
    startsAt: null,
    expiresAt: null,
    items: [
      {
        id: `item-${id}`,
        productId: 'p1',
        variantId: null,
        quantity: 1,
        product: {
          price: 4000,
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
}

describe('GET /public/:storeId/bundles', () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  afterEach(() => {
    vi.clearAllMocks();
    redisMock.get.mockResolvedValue(null);
  });

  // public-cache's module-level in-memory layer persists across tests (and
  // across a retry of the SAME test — vitest.config sets retry: 1) — a
  // fixed storeId would let attempt 2 hit the cache attempt 1 warmed and
  // never reach Prisma at all. Per-call unique id, not a shared constant.
  let storeSeq = 0;
  function uniqueStoreId(): string {
    storeSeq += 1;
    return `99999999-9999-9999-9999-${String(storeSeq).padStart(12, '0')}`;
  }

  it('caps the candidate query with take (#1553)', async () => {
    const storeId = uniqueStoreId();
    mockPrisma.bundle.findMany.mockResolvedValue([]);

    await request(app).get(`/api/v1/stores/public/${storeId}/bundles`);

    expect(mockPrisma.bundle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: expect.any(Number) })
    );
    expect(mockPrisma.bundle.findMany.mock.calls[0][0].take).toBeGreaterThan(0);
  });

  it('serves at most the cap and LOGS when a store exceeds it (P3 on PR #1977)', async () => {
    const { PUBLIC_BUNDLE_LIST_CAP } = await import('@api/routes/bundle.routes');
    const logger = (await import('@api/lib/logger')).default;
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const storeId = uniqueStoreId();
    const ids = Array.from({ length: PUBLIC_BUNDLE_LIST_CAP + 1 }, (_, i) => ({ id: `b${i}` }));
    mockPrisma.bundle.findMany.mockResolvedValue(ids);
    mockPrisma.bundle.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) =>
      bundleRow(where.id)
    );

    const res = await request(app).get(`/api/v1/stores/public/${storeId}/bundles`);

    expect(res.status).toBe(200);
    expect(mockPrisma.bundle.findMany.mock.calls[0][0].take).toBe(PUBLIC_BUNDLE_LIST_CAP + 1);
    expect(res.body.data.bundles).toHaveLength(PUBLIC_BUNDLE_LIST_CAP);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ storeId, cap: PUBLIC_BUNDLE_LIST_CAP }),
      expect.stringContaining('truncated')
    );
  });

  it('serves the SECOND request from cache — one DB hit, not two (#1565)', async () => {
    mockPrisma.bundle.findMany.mockResolvedValue([{ id: 'b1' }]);
    mockPrisma.bundle.findFirst.mockResolvedValue(bundleRow('b1'));
    const storeId = uniqueStoreId();

    const first = await request(app).get(`/api/v1/stores/public/${storeId}/bundles`);
    expect(first.status).toBe(200);
    expect(first.body.data.bundles).toHaveLength(1);

    // Cache layer: emulate the in-memory fallback carrying the write from
    // request 1 forward by having redis.get return what was `set`.
    const written = redisMock.set.mock.calls[0]?.[1];
    redisMock.get.mockResolvedValue(written);

    const second = await request(app).get(`/api/v1/stores/public/${storeId}/bundles`);
    expect(second.status).toBe(200);
    expect(second.body.data.bundles).toHaveLength(1);

    expect(mockPrisma.bundle.findMany).toHaveBeenCalledTimes(1);
  });

  it("a DIFFERENT store is not served the first store's cached bundles", async () => {
    const storeId = uniqueStoreId();
    const otherStoreId = uniqueStoreId();
    mockPrisma.bundle.findMany.mockResolvedValue([{ id: 'b1' }]);
    mockPrisma.bundle.findFirst.mockResolvedValue(bundleRow('b1'));
    await request(app).get(`/api/v1/stores/public/${storeId}/bundles`);

    mockPrisma.bundle.findMany.mockResolvedValue([]);
    const res = await request(app).get(`/api/v1/stores/public/${otherStoreId}/bundles`);

    expect(res.body.data.bundles).toEqual([]);
    expect(mockPrisma.bundle.findMany).toHaveBeenCalledTimes(2);
  });
});
