/**
 * `settings.receiptBarcodeShape` is validated at the API edge on create AND update:
 * plain | off | an approved shape id | null (clear); anything else is a 400.
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

const BAD = ['star', 'Palm', '', '<script>', 7, ['palm'], { shape: 'palm' }];

describe('settings.receiptBarcodeShape (create + update)', () => {
  it.each(BAD)('POST rejects %j', async bad => {
    const res = await request(app)
      .post('/stores')
      .send({ name: 'Shop', settings: { receiptBarcodeShape: bad } });
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
  it.each(BAD)('PUT rejects %j', async bad => {
    const res = await request(app)
      .put(`/stores/${STORE_ID}`)
      .send({ settings: { receiptBarcodeShape: bad } });
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
  it('accepts plain, off, a shape and null on both writers', async () => {
    for (const receiptBarcodeShape of ['plain', 'off', 'palm', 'french-fries', null]) {
      const post = await request(app)
        .post('/stores')
        .send({ name: 'Shop', settings: { receiptBarcodeShape } });
      expect(post.status).toBe(201);
      const put = await request(app)
        .put(`/stores/${STORE_ID}`)
        .send({ settings: { receiptBarcodeShape } });
      expect(put.status).toBe(200);
    }
  });
});

describe('settings.packingSlipNote (create + update)', () => {
  const BAD_NOTE = [7, ['x'], { a: 1 }, 'x'.repeat(301)];
  it.each(BAD_NOTE)('rejects %j', async bad => {
    const post = await request(app)
      .post('/stores')
      .send({ name: 'Shop', settings: { packingSlipNote: bad } });
    expect(post.status).toBe(400);
    const put = await request(app)
      .put(`/stores/${STORE_ID}`)
      .send({ settings: { packingSlipNote: bad } });
    expect(put.status).toBe(400);
  });
  it('accepts text, empty and null (clear)', async () => {
    for (const packingSlipNote of ['شكراً لتسوقك معنا', '', null, 'x'.repeat(300)]) {
      expect(
        (await request(app).put(`/stores/${STORE_ID}`).send({ settings: { packingSlipNote } }))
          .status
      ).toBe(200);
    }
  });
  it('is NOT a public storefront key (staff-only print text)', async () => {
    const { PUBLIC_SETTINGS_KEYS } = await import('@api/lib/public-store-settings');
    expect(PUBLIC_SETTINGS_KEYS).not.toContain('packingSlipNote');
  });
});
