/**
 * T1 route hardening on store.routes.ts: BE:S-14 (domain body), S-15 (status / template bodies), F-3 (branding-bundle),
 * FP-1 (an echoed server-owned flag is dropped, not refused).
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

const svc = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  getById: vi.fn(),
  updateBrandingBundle: vi.fn(),
  setStatus: vi.fn(),
  updateTemplate: vi.fn(),
}));
vi.mock('@api/services/store.service', () => ({
  StoreService: svc,
  applySocialLinksPatch: vi.fn(),
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
  for (const f of Object.values(svc)) f.mockReset().mockResolvedValue({ id: STORE_ID, slug: 'ok' });
  svc.getById.mockResolvedValue({
    id: STORE_ID,
    slug: 'old',
    socialLinks: { facebook: 'https://f.b/x' },
  });
  app ??= await buildApp();
});

describe('PUT /stores/:id/domain (BE:S-14)', () => {
  it.each([{}, { domain: 123 }, { domain: ['a.com'] }, { Domain: 'a.com' }])(
    'a body without a string-or-null domain (%j) is a 400 and never reaches the store',
    async body => {
      const res = await request(app).put(`/stores/${STORE_ID}/domain`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(svc.getById).not.toHaveBeenCalled();
    }
  );
});

describe('status and template bodies (BE:S-15)', () => {
  it.each([{}, { status: 5 }, { status: 'inactive' }, { status: null }])(
    'PATCH /stores/:id/status %j is 400 INVALID_STATUS',
    async body => {
      const res = await request(app).patch(`/stores/${STORE_ID}/status`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_STATUS');
      expect(svc.setStatus).not.toHaveBeenCalled();
    }
  );

  it.each([{}, { template: '' }, { template: 7 }])(
    'PUT /stores/:id/template %j is a 400',
    async body => {
      const res = await request(app).put(`/stores/${STORE_ID}/template`).send(body);
      expect(res.status).toBe(400);
      expect(svc.updateTemplate).not.toHaveBeenCalled();
    }
  );

  it('a template name that is far too long is a VALIDATION_ERROR, not a 500', async () => {
    const res = await request(app)
      .put(`/stores/${STORE_ID}/template`)
      .send({ template: 'x'.repeat(200) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PUT /stores/:id/branding-bundle (BE:F-3)', () => {
  it('hands every part the page sent to ONE service call', async () => {
    const res = await request(app)
      .put(`/stores/${STORE_ID}/branding-bundle`)
      .send({
        branding: { name: 'Shop' },
        contact: { email: 'a@b.com' },
        social: { instagram: 'https://instagram.com/x' },
        settings: { contact: { addressLink: true } },
        blogEnabled: true,
      });
    expect(res.status).toBe(200);
    expect(svc.updateBrandingBundle).toHaveBeenCalledTimes(1);
    const parts = svc.updateBrandingBundle.mock.calls[0][1];
    expect(parts).toMatchObject({
      branding: { name: 'Shop' },
      contact: { email: 'a@b.com' },
      settings: { contact: { addressLink: true } },
      blogEnabled: true,
    });
    expect(parts.theme).toBeUndefined(); // untouched parts are not written
    // social is a KEY patch (set what was sent), so a key the body omitted is never touched (BE:F-3: the DO merges it atomically)
    expect(parts.social).toEqual({ set: { instagram: 'https://instagram.com/x' }, remove: [] });
  });

  it('a failing bundle is one error response', async () => {
    svc.updateBrandingBundle.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app)
      .put(`/stores/${STORE_ID}/branding-bundle`)
      .send({ branding: { name: 'Shop' } });
    expect(res.status).toBe(500);
  });

  it('an unknown top-level key is refused (strict)', async () => {
    const res = await request(app)
      .put(`/stores/${STORE_ID}/branding-bundle`)
      .send({ branding: { name: 'Shop' }, ownerId: 'someone-else' });
    expect(res.status).toBe(400);
    expect(svc.updateBrandingBundle).not.toHaveBeenCalled();
  });

  it('the bundle settings go through the same checks as PUT /:id (a planted ebdaWhatsApp is refused)', async () => {
    const res = await request(app)
      .put(`/stores/${STORE_ID}/branding-bundle`)
      .send({ settings: { ebdaWhatsApp: { linked: true } } });
    expect(res.status).toBe(400);
    expect(svc.updateBrandingBundle).not.toHaveBeenCalled();
  });
});

describe('echoed server-owned flags (BE:S-8, Ruling FP-1)', () => {
  it.each(['mcpWriteEnabled', 'goldAllowDeferredPayment'])(
    'PUT /stores/:id with settings.%s from a stale whole copy is accepted (the service drops it)',
    async key => {
      const res = await request(app)
        .put(`/stores/${STORE_ID}`)
        .send({ name: 'Shop', settings: { [key]: true, currency: 'EGP' } });
      expect(res.status).toBe(200);
      expect(svc.update).toHaveBeenCalledTimes(1);
    }
  );
});
