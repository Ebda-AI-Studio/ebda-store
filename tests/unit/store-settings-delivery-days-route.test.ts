/**
 * `settings.deliveryDays` (store-wide delivery estimate, business days) is validated with the
 * shared `deliveryDaysSchema` on EVERY route that can write `Store.settings`: create AND update.
 * Valid range and an explicit null (clear) pass; anything else is a 400 and the service is
 * never called. Super-admin provisioning (`POST /admin/stores`) uses a strict `settings` object
 * that drops unknown keys, so it cannot write the key at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin' };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
  customerUserId: () => 'customer-1',
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
  checkStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/rbac', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/utils/store-helpers', () => ({ getAuthUser: (req: any) => req.user }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@ebda/database', () => ({
  prisma: { store: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() } },
  Prisma: { DbNull: null },
  StoreStatus: { active: 'active', suspended: 'suspended' },
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withStore: async (_s: string, fn: any) => fn((await import('@ebda/database')).prisma),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withUser: async (_u: string, fn: any) => fn((await import('@ebda/database')).prisma),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  asPlatformOperator: (_u: string, fn: any) => fn(),
}));
vi.mock('@api/middleware/tenant-context', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tenantContext: (_req: any, _res: any, next: any) => next(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  storeScopeContext: (_req: any, _res: any, next: any) => next(),
}));

// The per-account daily cap (SP5 task 4) is covered in self-serve-abuse.test.ts;
// here it is a pass-through so the route's slug contract stays the subject.
vi.mock('@api/services/store-creation-limit', () => ({
  assertStoreCreationBudget: vi.fn().mockResolvedValue(undefined),
  withStoreCreationLock: (_owner: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/services/plan-limit.service', () => ({ assertWithinLimit: vi.fn() }));

const create = vi.fn();
const update = vi.fn();
vi.mock('@api/services/store.service', () => ({
  StoreService: {
    create: (...a: unknown[]) => create(...a),
    update: (...a: unknown[]) => update(...a),
    getById: vi.fn().mockResolvedValue({ id: 'store-1', slug: 'old-slug', socialLinks: {} }),
  },
}));
vi.mock('@api/services/domain-provider', () => ({
  resolveDomainService: vi.fn(() => ({ isConfigured: () => false })),
}));
vi.mock('@api/services/store-mailer.service', () => ({ StoreMailer: {} }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { invalidateCache: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@api/lib/cors-cache', () => ({ bustCorsCache: vi.fn() }));
vi.mock('@api/lib/public-cache', () => ({
  invalidateCached: vi.fn(),
  invalidateCachedPrefix: vi.fn(),
  invalidateStoreProductCaches: vi.fn(),
  invalidateCustomersCache: vi.fn(),
}));
vi.mock('@api/lib/marketing-pixels-secrets', () => ({
  maskMarketingPixelSecrets: (v: unknown) => v,
  preserveMaskedPixelSecrets: (v: unknown) => v,
}));
vi.mock('@api/config', () => ({ config: { cfFallbackOrigin: 'fallback.example.com' } }));

const STORE_ID = '11111111-1111-1111-1111-111111111111';

async function buildApp() {
  const { default: router } = await import('@api/routes/store.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const app = express();
  app.use(express.json());
  app.use('/stores', router);
  app.use(errorHandler);
  return app;
}

let app: express.Express;
beforeEach(async () => {
  create.mockReset().mockResolvedValue({ id: STORE_ID, slug: 'ok' });
  update.mockReset().mockResolvedValue({ id: STORE_ID, slug: 'ok' });
  app ??= await buildApp();
});

const BAD = [
  { min: 5, max: 2 },
  { min: -1, max: 2 },
  { min: 1, max: 31 },
  { min: 1.5, max: 2 },
  { min: 1 },
  'soon',
];

describe('POST /stores: settings.deliveryDays', () => {
  it.each(BAD)('rejects %j', async bad => {
    const res = await request(app)
      .post('/stores')
      .send({ name: 'Shop', settings: { deliveryDays: bad } });
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
  it('accepts a valid range and an explicit null', async () => {
    for (const deliveryDays of [{ min: 2, max: 4 }, null]) {
      const res = await request(app)
        .post('/stores')
        .send({ name: 'Shop', settings: { deliveryDays } });
      expect(res.status).toBe(201);
    }
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe('PUT /stores/:id: settings.deliveryDays', () => {
  it.each(BAD)('rejects %j', async bad => {
    const res = await request(app)
      .put(`/stores/${STORE_ID}`)
      .send({ settings: { deliveryDays: bad } });
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
  it('accepts a valid range and an explicit null (the clear form)', async () => {
    for (const deliveryDays of [{ min: 0, max: 30 }, null]) {
      const res = await request(app)
        .put(`/stores/${STORE_ID}`)
        .send({ settings: { deliveryDays } });
      expect(res.status).toBe(200);
    }
    expect(update.mock.calls[1][1].settings).toEqual({ deliveryDays: null });
  });
});

const BAD_OFF_DAYS = [[0, 1, 2, 3, 4, 5, 6], [7], [-1], [5, 5], [1.5], ['5'], 'friday'];

describe('settings.deliveryOffDays (create + update)', () => {
  it.each(BAD_OFF_DAYS)('POST rejects %j', async bad => {
    const res = await request(app)
      .post('/stores')
      .send({ name: 'Shop', settings: { deliveryOffDays: bad } });
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
  it.each(BAD_OFF_DAYS)('PUT rejects %j', async bad => {
    const res = await request(app)
      .put(`/stores/${STORE_ID}`)
      .send({ settings: { deliveryOffDays: bad } });
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
  it('accepts weekdays, [] (delivers every day) and an explicit null on both writers', async () => {
    for (const deliveryOffDays of [[5, 6], [], null]) {
      const post = await request(app)
        .post('/stores')
        .send({ name: 'Shop', settings: { deliveryOffDays } });
      expect(post.status).toBe(201);
      const put = await request(app)
        .put(`/stores/${STORE_ID}`)
        .send({ settings: { deliveryOffDays } });
      expect(put.status).toBe(200);
    }
    expect(update.mock.calls[2][1].settings).toEqual({ deliveryOffDays: null });
  });
});

const BAD_DAYS_AHEAD = [0, 15, -1, 1.5, '5', true, {}];

describe('settings.checkoutDelivery.daysAhead (Ruling B4-7, create + update)', () => {
  it.each(BAD_DAYS_AHEAD)('POST rejects %j', async bad => {
    const res = await request(app)
      .post('/stores')
      .send({ name: 'Shop', settings: { checkoutDelivery: { daysAhead: bad } } });
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
  it.each(BAD_DAYS_AHEAD)('PUT rejects %j', async bad => {
    const res = await request(app)
      .put(`/stores/${STORE_ID}`)
      .send({ settings: { checkoutDelivery: { daysAhead: bad } } });
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
  it('accepts 1..14, an explicit null and an absent key, and leaves the rest of checkoutDelivery alone', async () => {
    for (const daysAhead of [1, 5, 14, null, undefined]) {
      const settings = {
        checkoutDelivery: {
          note: { enabled: false, text: '', textAr: '' },
          windows: { enabled: true, items: [] },
          ...(daysAhead === undefined ? {} : { daysAhead }),
        },
      };
      const post = await request(app).post('/stores').send({ name: 'Shop', settings });
      expect(post.status).toBe(201);
      const put = await request(app).put(`/stores/${STORE_ID}`).send({ settings });
      expect(put.status).toBe(200);
    }
    expect(update).toHaveBeenCalledTimes(5);
  });
});
