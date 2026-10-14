/**
 * The component wipe on `PUT /stores/:storeId/bundles/:id` is NESTED in the
 * bundle update rather than a standalone `bundleItem.deleteMany` ahead of it,
 * so the wipe and the rewrite fail together by construction.
 *
 * The CI AI reviewer proposed this shape on PR #1551 arguing a live
 * data-loss window: the ambient tenant transaction
 * (`middleware/tenant-context.ts:75`) commits on every status <500, so a wipe
 * landing before a 4xx would be committed. The first half is true; the
 * conclusion is NOT reachable on this route. Every 4xx-throwing check
 * (`resolveBundleLines`, `assertPriceWithinComponentSum`, the allocatable
 * guard) runs BEFORE the wipe, and a raw Prisma error after it is unmapped
 * (`throwIfBundleFkViolation` is never called in `bundle.routes.ts`), so it
 * surfaces as a 500 and the transaction DOES roll back.
 *
 * The nested form is kept anyway: it makes atomicity structural instead of
 * dependent on statement ordering, so adding a 4xx mapping to this route later
 * cannot silently open the window. These tests pin both properties — the
 * nesting, and the ordering that made the old form safe.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const STORE_ID = '11111111-1111-1111-1111-111111111111';
const BUNDLE_ID = '99999999-9999-9999-9999-999999999999';
const P_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    product: { findMany: vi.fn() },
    bundle: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
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

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.product.findMany.mockResolvedValue([
    { id: P_A, name: 'Dates 1kg', price: 5000, variants: [] },
  ]);
  // The bundle being edited exists and belongs to this store.
  mockPrisma.bundle.findFirst.mockResolvedValue({
    id: BUNDLE_ID,
    storeId: STORE_ID,
    slug: 'ramadan-box',
    items: [{ productId: P_A, variantId: null, quantity: 1 }],
  });
});

const putBody = {
  name: 'Ramadan Box',
  slug: 'ramadan-box',
  pricingType: 'percentage',
  pricingValue: 1000,
  items: [{ productId: P_A, quantity: 2 }],
};

describe('PUT /:storeId/bundles/:id — the item wipe is atomic with the rewrite', () => {
  it('never issues a standalone bundleItem.deleteMany', async () => {
    mockPrisma.bundle.update.mockResolvedValue({ id: BUNDLE_ID });

    await request(app).put(`/api/v1/stores/${STORE_ID}/bundles/${BUNDLE_ID}`).send(putBody);

    // The wipe must ride inside the update, so the standalone delete is never
    // reached. This is the guard: a refactor that hoists it back out re-opens
    // the data-loss window.
    expect(mockPrisma.bundleItem.deleteMany).not.toHaveBeenCalled();

    const updateArg = mockPrisma.bundle.update.mock.calls[0]?.[0];
    expect(updateArg?.data?.items?.deleteMany).toEqual({});
  });

  it('rejects an invalid component before issuing ANY write', async () => {
    // The ordering that made the pre-nesting form safe, pinned so a refactor
    // that moves validation after the writes is caught. VARIANT_REQUIRED is a
    // 400 — exactly the status that would be committed if it fired late.
    mockPrisma.product.findMany.mockResolvedValue([
      { id: P_A, name: 'T-Shirt', price: 5000, variants: [{ id: 'v1', price: 5200 }] },
    ]);

    const res = await request(app)
      .put(`/api/v1/stores/${STORE_ID}/bundles/${BUNDLE_ID}`)
      .send(putBody); // component pins no variant on a variant product

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VARIANT_REQUIRED');
    expect(mockPrisma.bundleItem.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.bundle.update).not.toHaveBeenCalled();
  });
});
