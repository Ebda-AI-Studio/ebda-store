/**
 * Route-level test for Task 8, Part 1: the admin coupon create/update routes
 * previously stripped the five targeting fields (customerGroupId,
 * firstOrderOnly, minQuantity, scopeProductIds, scopeCategoryIds) before
 * they reached `CouponService` even though the service already persisted
 * them (see promotion.routes.ts's createSchema for the shared shape).
 * Asserts the fields now round-trip through `POST /:storeId/coupons` and
 * `PUT /:storeId/coupons/:id`. Same app-bootstrap pattern as
 * tests/unit/coupon-validate-targeting-route.test.ts.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    coupon: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    // BE:S-25: the targeted customer group must belong to the store
    customerGroup: { findFirst: vi.fn().mockResolvedValue({ id: 'group' }) },
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
  // coupons/validate runs optionalAuthenticate (issue 2066): no token = guest.
  optionalAuthenticate: (_req: any, _res: any, next: any) => next(),
  customerUserId: () => undefined,
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
const GROUP_ID = '22222222-2222-2222-2222-222222222222';
const PRODUCT_ID_1 = '33333333-3333-3333-3333-333333333333';
const PRODUCT_ID_2 = '44444444-4444-4444-4444-444444444444';
const PRODUCT_ID_3 = '55555555-5555-5555-5555-555555555555';
const CATEGORY_ID_1 = '66666666-6666-6666-6666-666666666666';

describe('admin coupon routes — targeting fields round-trip', () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('POST /:storeId/coupons passes targeting fields through to CouponService.create', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue(null); // no duplicate code
    mockPrisma.coupon.create.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'coupon-1', ...data })
    );

    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/coupons`)
      .send({
        code: 'VIP10',
        name: 'VIP 10%',
        type: 'percentage',
        value: 10,
        customerGroupId: GROUP_ID,
        firstOrderOnly: true,
        minQuantity: 2,
        scopeProductIds: [PRODUCT_ID_1, PRODUCT_ID_2],
        scopeCategoryIds: [CATEGORY_ID_1],
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(mockPrisma.coupon.create).toHaveBeenCalledTimes(1);
    const createArg = mockPrisma.coupon.create.mock.calls[0][0].data;
    expect(createArg.customerGroupId).toBe(GROUP_ID);
    expect(createArg.firstOrderOnly).toBe(true);
    expect(createArg.minQuantity).toBe(2);
    expect(createArg.scopeProductIds).toEqual([PRODUCT_ID_1, PRODUCT_ID_2]);
    expect(createArg.scopeCategoryIds).toEqual([CATEGORY_ID_1]);
    expect(res.body.data.coupon.customerGroupId).toBe(GROUP_ID);
    expect(res.body.data.coupon.firstOrderOnly).toBe(true);
    expect(res.body.data.coupon.minQuantity).toBe(2);
    expect(res.body.data.coupon.scopeProductIds).toEqual([PRODUCT_ID_1, PRODUCT_ID_2]);
    expect(res.body.data.coupon.scopeCategoryIds).toEqual([CATEGORY_ID_1]);
  });

  it('PUT /:storeId/coupons/:id passes targeting fields through to CouponService.update', async () => {
    mockPrisma.coupon.findFirst.mockResolvedValue({ id: 'coupon-1', code: 'VIP10' }); // getById + duplicate check
    mockPrisma.coupon.update.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: 'coupon-1', ...data })
    );

    const res = await request(app)
      .put(`/api/v1/stores/${STORE_ID}/coupons/coupon-1`)
      .send({
        customerGroupId: GROUP_ID,
        firstOrderOnly: false,
        minQuantity: 3,
        scopeProductIds: [PRODUCT_ID_3],
        scopeCategoryIds: [],
      });

    expect(res.status).toBe(200);
    expect(mockPrisma.coupon.update).toHaveBeenCalledTimes(1);
    const updateArg = mockPrisma.coupon.update.mock.calls[0][0].data;
    expect(updateArg.customerGroupId).toBe(GROUP_ID);
    expect(updateArg.firstOrderOnly).toBe(false);
    expect(updateArg.minQuantity).toBe(3);
    expect(updateArg.scopeProductIds).toEqual([PRODUCT_ID_3]);
    expect(updateArg.scopeCategoryIds).toEqual([]);
  });
});
