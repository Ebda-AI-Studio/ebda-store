/**
 * SP4 — a store's slug IS its address (`<slug>.ebda.app`), so store create and
 * update refuse a slug that is malformed or RESERVED (`app`, `api`, `www`,
 * `support`, …) with a stable machine-readable code — `SLUG_RESERVED`,
 * `SLUG_TOO_SHORT`, … — rather than a generic VALIDATION_ERROR, and the
 * service is never called. The reserved list is the single one in
 * `@ebda/shared`; this test iterates it, so adding a label there is covered
 * here without an edit.
 *
 * HTTP-level (supertest) against the real `store.routes.ts` router with the
 * service mocked: what is asserted is the route's contract, not a database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { RESERVED_SLUGS, STORE_SLUG_MIN_LENGTH } from '@ebda/shared';

// `id` is reserved as a hostname but is already below the slug minimum (SLUG_TOO_SHORT).
// Plus the prefix rule (`preview-*`), which is not an exact list entry.
const RESERVED_CREATABLE = [
  ...RESERVED_SLUGS.filter(s => s.length >= STORE_SLUG_MIN_LENGTH),
  'preview-x',
  'preview-pr-123',
];

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

describe('POST /stores — slug rules', () => {
  it.each([...RESERVED_CREATABLE])(
    'rejects the reserved slug %j with SLUG_RESERVED (400)',
    async slug => {
      const res = await request(app).post('/stores').send({ name: 'My Shop', slug });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('SLUG_RESERVED');
      expect(res.body.error.message).toMatch(/reserved/i);
      expect(create).not.toHaveBeenCalled();
    }
  );

  it('is case-insensitive about the reserved list only via validation: an uppercase slug is invalid, not accepted', async () => {
    const res = await request(app).post('/stores').send({ name: 'My Shop', slug: 'APP' });
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['ab', 'SLUG_TOO_SHORT'],
    ['a'.repeat(41), 'SLUG_TOO_LONG'],
    ['My_Shop', 'SLUG_INVALID_CHARS'],
    ['-shop', 'SLUG_INVALID_HYPHEN'],
    ['shop-', 'SLUG_INVALID_HYPHEN'],
    ['my--shop', 'SLUG_INVALID_HYPHEN'],
  ])('rejects %j with %s', async (slug, code) => {
    const res = await request(app).post('/stores').send({ name: 'My Shop', slug });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect(create).not.toHaveBeenCalled();
  });

  it('accepts a valid, unreserved slug and passes it to the service unchanged', async () => {
    const res = await request(app).post('/stores').send({ name: 'Amelia', slug: 'amelia-aurum' });
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1].slug).toBe('amelia-aurum');
    // A store_admin never gets the protected-name override NOR the plan-gate bypass.
    expect(create.mock.calls[0][2]).toEqual({ allowProtectedSlug: false, platformOperator: false });
  });

  it('a body with no slug is still accepted (the service derives one from the name)', async () => {
    const res = await request(app).post('/stores').send({ name: 'Amelia' });
    expect(res.status).toBe(201);
    expect(create.mock.calls[0][1].slug).toBeUndefined();
  });

  it('other validation errors keep the generic VALIDATION_ERROR code', async () => {
    const res = await request(app).post('/stores').send({ slug: 'amelia' }); // name missing
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PUT /stores/:id — slug rules', () => {
  it.each([...RESERVED_CREATABLE])(
    'rejects renaming a store to the reserved slug %j',
    async slug => {
      const res = await request(app).put(`/stores/${STORE_ID}`).send({ slug });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('SLUG_RESERVED');
      expect(update).not.toHaveBeenCalled();
    }
  );

  it('accepts a valid new slug', async () => {
    const res = await request(app).put(`/stores/${STORE_ID}`).send({ slug: 'new-address' });
    expect(res.status).toBe(200);
    expect(update.mock.calls[0][1].slug).toBe('new-address');
  });

  it('an update that does not touch the slug is unaffected', async () => {
    const res = await request(app).put(`/stores/${STORE_ID}`).send({ name: 'Renamed' });
    expect(res.status).toBe(200);
  });
});

describe('PUT /stores/:id/domain — a custom domain can never be an Ebda host', () => {
  it.each([
    'ebda.app',
    'www.ebda.app',
    'rival.ebda.app',
    'RIVAL.EBDA.APP',
    'admin.ebda.app',
    'x.y.ebda.app',
    '127.0.0.1',
    'localhost',
    'not a domain',
  ])('rejects %j with DOMAIN_INVALID before touching the provider', async domain => {
    const res = await request(app).put(`/stores/${STORE_ID}/domain`).send({ domain });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DOMAIN_INVALID');
  });

  it('a real third-party domain passes the check (and reaches the provider gate)', async () => {
    const res = await request(app)
      .put(`/stores/${STORE_ID}/domain`)
      .send({ domain: 'ameliaaurum.com' });
    // The provider is not configured in this test, so the next gate answers.
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DOMAIN_FEATURE_UNAVAILABLE');
  });
});

// Ruling B2-17: the demo showroom slugs are unclaimable on create AND update.
describe.each(['storedemo', 'storedemo-souq', 'storedemo-anything'])('demo slug %s', slug => {
  it('POST /stores refuses it with SLUG_RESERVED and never calls the service', async () => {
    const res = await request(app).post('/stores').send({ name: 'Shop', slug });
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('SLUG_RESERVED');
    expect(create).not.toHaveBeenCalled();
  });
  it('PUT /stores/:id refuses it with SLUG_RESERVED and never calls the service', async () => {
    const res = await request(app).put(`/stores/${STORE_ID}`).send({ slug });
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('SLUG_RESERVED');
    expect(update).not.toHaveBeenCalled();
  });
});
