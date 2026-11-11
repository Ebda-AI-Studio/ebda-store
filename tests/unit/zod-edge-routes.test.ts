/**
 * Zod at every edge (issue 2473) — the request-body reads that used to cast or
 * destructure `req.body` unvalidated. One reject-invalid and one accept-valid
 * case per route; each reject case fails on the pre-fix code.
 *
 * Verified-as-already-validated (no change, no test needed here): the MCP
 * routes hand the body to the SDK transport, whose JSONRPCMessageSchema.parse
 * answers 400/-32700; mfa.routes.ts safeParses all four handlers;
 * campaign-public.routes.ts passes the token to verifyUnsubscribeToken(unknown).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const m = vi.hoisted(() => ({
  sendAlert: vi.fn(async () => undefined),
  addRelation: vi.fn(async () => ({ id: 'rel-1' })),
  wishlistFind: vi.fn(async () => ({ id: 'w1', isPublic: false })),
  wishlistUpdate: vi.fn(async (a: any) => ({ id: 'w1', isPublic: a.data.isPublic })),
  checkStoreAccess: vi.fn(async () => ({ ok: true })),
  revalidateTag: vi.fn(),
}));

vi.mock('@api/services/alerts.service', () => ({ sendAlert: m.sendAlert }));
vi.mock('@api/services/recommendation.service', () => ({
  recommendationService: { addRelation: m.addRelation },
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => true },
}));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u1', role: 'store_admin', storeId: 's1' };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
  customerUserId: (req: any) => req.user?.userId,
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
  checkStoreAccess: m.checkStoreAccess,
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/rbac', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/tenant-context', () => ({
  userContext: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  uploadLimiter: (_req: any, _res: any, next: any) => next(),
  dailyUploadLimiter: (_req: any, _res: any, next: any) => next(),
  auditLog: vi.fn(),
}));
vi.mock('@api/services/storage.service', () => ({
  StorageService: {},
}));
vi.mock('@api/services/image-resize.service', () => ({
  resizeToAspect: vi.fn(),
  enforceMaxDimensions: vi.fn(),
}));
vi.mock('@ebda/database', () => ({
  prisma: { wishlist: { findFirst: m.wishlistFind, update: m.wishlistUpdate, create: vi.fn() } },
  runInTenantContext: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('next/cache', () => ({ revalidateTag: m.revalidateTag }));
// One zod instance for the shared schema and the routes under test.
vi.mock('@ebda/shared', async () => await import('../../packages/shared/src/index'));

import alertWebhooks from '@api/routes/alert-webhooks.routes';
import recommendationRoutes from '@api/routes/recommendation.routes';
import wishlistRoutes from '@api/routes/wishlist.routes';
import uploadRoutes from '@api/routes/upload.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { POST as revalidatePost } from '../../apps/web/src/app/api/revalidate/route';

function app(mount: string, router: express.Router): Express {
  const a = express();
  a.use(express.json());
  a.use(mount, router);
  a.use(errorHandler);
  return a;
}

beforeEach(() => vi.clearAllMocks());

describe('alert-webhooks — wrongly-typed provider payloads degrade, never 500', () => {
  const a = app('/hooks', alertWebhooks);

  it('/generic: non-string title is rejected 400 (was TypeError → 500)', async () => {
    const res = await request(a).post('/hooks/generic').send({ title: 123 });
    expect(res.status).toBe(400);
    expect(m.sendAlert).not.toHaveBeenCalled();
  });
  it('/generic: valid body is delivered', async () => {
    const res = await request(a).post('/hooks/generic').send({ title: 'db down', level: 'p0' });
    expect(res.status).toBe(200);
    expect(m.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'db down', level: 'p0' })
    );
  });
  it('/generic: unknown level falls back to p1', async () => {
    await request(a).post('/hooks/generic').send({ title: 't', level: 'nonsense' });
    expect(m.sendAlert).toHaveBeenCalledWith(expect.objectContaining({ level: 'p1' }));
  });
  it('/sentry: a non-object nested field is dropped, alert still sent', async () => {
    const res = await request(a)
      .post('/hooks/sentry')
      .send({ data: { issue: 'oops' }, event: { title: 99 } });
    expect(res.status).toBe(200);
    expect(m.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'sentry: sentry alert' })
    );
  });
  it('/sentry: valid payload keeps its title', async () => {
    await request(a)
      .post('/hooks/sentry')
      .send({ data: { issue: { title: 'Boom', level: 'error', project: { slug: 'ebda-api' } } } });
    expect(m.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'sentry: Boom', level: 'p1', source: 'sentry.ebda-api' })
    );
  });
  it('/axiom, /posthog, /railway: wrong-typed fields do not 500', async () => {
    for (const [path, body] of [
      ['/hooks/axiom', { monitor: 'x', match: { count: 'many' }, url: 5 }],
      ['/hooks/posthog', { insight: 7, matches: 'nope' }],
      ['/hooks/railway', { type: 42, deployment: { meta: { commitMessage: 9 } } }],
    ] as const) {
      const res = await request(a).post(path).send(body);
      expect(res.status, path).toBe(200);
    }
  });
  it('/railway: valid payload classifies DEPLOY_FAILED as p0', async () => {
    await request(a).post('/hooks/railway').send({ type: 'DEPLOY_FAILED' });
    expect(m.sendAlert).toHaveBeenCalledWith(expect.objectContaining({ level: 'p0' }));
  });
});

describe('recommendation POST /:storeId/products/:productId/relations', () => {
  const a = app('/stores', recommendationRoutes);
  const url = '/stores/s1/products/p1/relations';

  it('rejects a non-string targetProductId (was: any truthy value reached the service)', async () => {
    const res = await request(a)
      .post(url)
      .send({ targetProductId: { $ne: null }, type: 'upsell' });
    expect(res.status).toBe(400);
    expect(m.addRelation).not.toHaveBeenCalled();
  });
  it('rejects a non-integer position', async () => {
    const res = await request(a)
      .post(url)
      .send({ targetProductId: 'p2', type: 'upsell', position: 'x' });
    expect(res.status).toBe(400);
    expect(m.addRelation).not.toHaveBeenCalled();
  });
  it('keeps the MISSING_FIELDS code for an absent field', async () => {
    const res = await request(a).post(url).send({ type: 'upsell' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_FIELDS');
  });
  it('accepts a valid relation', async () => {
    const res = await request(a)
      .post(url)
      .send({ targetProductId: 'p2', type: 'upsell', position: 1 });
    expect(res.status).toBe(201);
    expect(m.addRelation).toHaveBeenCalledWith('s1', 'p1', {
      targetProductId: 'p2',
      type: 'upsell',
      position: 1,
    });
  });
});

describe('wishlist PUT /visibility', () => {
  const a = app('/wishlist', wishlistRoutes);
  const send = (body: unknown) =>
    request(a)
      .put('/wishlist/visibility')
      .set('x-store-id', 'store-1')
      .send(body as object);

  it('rejects a non-boolean isPublic', async () => {
    const res = await send({ isPublic: 'true' });
    expect(res.status).toBe(400);
    expect(m.wishlistUpdate).not.toHaveBeenCalled();
  });
  it('accepts a boolean', async () => {
    const res = await send({ isPublic: true });
    expect(res.status).toBe(200);
    expect(res.body.data.isPublic).toBe(true);
  });
});

describe('uploads POST /presigned is gone (Ruling FU46-5b)', () => {
  const a = app('/uploads', uploadRoutes);

  it('answers 404: a direct-to-R2 PUT is never byte-checked, so the route no longer exists', async () => {
    const res = await request(a)
      .post('/uploads/presigned')
      .send({ filename: 'a.png', contentType: 'image/png', folder: 'products', storeId: 's1' });
    expect(res.status).toBe(404);
    expect(m.checkStoreAccess).not.toHaveBeenCalled();
  });
});

describe('web POST /api/revalidate', () => {
  const call = (body: string) =>
    revalidatePost(new Request('http://x/api/revalidate', { method: 'POST', body }) as never);

  beforeEach(() => {
    process.env.REVALIDATE_SECRET = 'shh';
  });

  it('answers 400 for valid JSON that is not an object (was TypeError → 500)', async () => {
    for (const body of ['null', '[]', '42', '"s"']) {
      const res = await call(body);
      expect(res.status, body).toBe(400);
    }
  });
  it('still 401s a wrong secret and purges on a valid body', async () => {
    expect((await call(JSON.stringify({ secret: 'no', tags: ['a'] }))).status).toBe(401);
    const ok = await call(JSON.stringify({ secret: 'shh', tags: ['products:1'] }));
    expect(ok.status).toBe(200);
    expect(m.revalidateTag).toHaveBeenCalledWith('products:1', { expire: 0 });
  });
});
