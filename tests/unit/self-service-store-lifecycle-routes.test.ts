/** Routes for the store lifecycle (A11): owner-only, Zod at the edge, store id from the path. */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const OWNER = 'owner-1';
vi.mock('@api/config', () => ({
  config: { encryptionKey: 'test-encryption-key-0123456789abcdef' },
}));
vi.mock('@api/services/redis.service', () => ({
  redis: { isAvailable: () => false, getClient: () => null },
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const m = vi.hoisted(() => ({
  preview: vi.fn(),
  schedule: vi.fn(),
  cancel: vi.fn(),
  status: vi.fn(),
  exportBundle: vi.fn(),
}));
vi.mock('@api/services/store-deletion.service', async () => {
  const real = await vi.importActual<typeof import('@api/services/store-deletion.service')>(
    '@api/services/store-deletion.service'
  );
  return {
    ...real,
    previewStoreDeletion: m.preview,
    scheduleStoreDeletion: m.schedule,
    cancelStoreDeletion: m.cancel,
    readDeletionStatus: m.status,
  };
});
vi.mock('@api/services/store-deletion.wiring', () => ({ productionDeletionDeps: () => ({}) }));
vi.mock('@api/services/store-export.wiring', () => ({ exportStoreBundle: m.exportBundle }));
vi.mock('@api/middleware/auth', async () => {
  const real = await vi.importActual<typeof import('@api/middleware/auth')>('@api/middleware/auth');
  return {
    ...real,
    authenticate: (req: any, res: any, next: any) => {
      const role = req.header('x-role');
      if (!role) return res.status(401).json({ success: false });
      req.user = { userId: req.header('x-user') ?? OWNER, role, email: 'o@example.com' };
      next();
    },
  };
});
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (req: any, res: any, next: any) =>
    req.params.storeId === 'store-a' ? next() : res.status(404).json({ success: false }),
}));
vi.mock('@api/middleware/tenant-context', () => ({
  tenantContext: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/security', async () => {
  const real = await vi.importActual<typeof import('@api/middleware/security')>(
    '@api/middleware/security'
  );
  return { ...real, auditLog: vi.fn(async () => undefined) };
});

let app: Express;
beforeAll(async () => {
  const router = (await import('@api/routes/store-deletion.routes')).default;
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/', router);
  app.use(errorHandler as any);
});
beforeEach(() => {
  Object.values(m).forEach(f => f.mockReset());
  m.preview.mockResolvedValue({
    ok: true,
    slug: 'shop-a',
    confirmToken: 't.t',
    coolingOffDays: 14,
    reasons: [],
  });
  m.schedule.mockResolvedValue({
    id: 'r1',
    state: 'pending',
    executeAfter: '2026-11-28T10:00:00.000Z',
  });
  m.cancel.mockResolvedValue({ id: 'r1', state: 'cancelled' });
  m.status.mockResolvedValue({ request: null });
  m.exportBundle.mockResolvedValue({ ok: true, zip: Buffer.from('zip'), filename: 'x.zip' });
});

it('unauthenticated is 401', async () => {
  expect((await request(app).post('/stores/store-a/deletion').send({})).status).toBe(401);
});
it('customer role is 403 on every owner route', async () => {
  for (const [method, url] of [
    ['post', '/stores/store-a/deletion/preview'],
    ['post', '/stores/store-a/deletion'],
    ['delete', '/stores/store-a/deletion'],
    ['get', '/stores/store-a/deletion'],
    ['get', '/stores/store-a/export'],
  ] as const) {
    const res = await (request(app) as any)[method](url).set('x-role', 'customer').send({});
    expect(res.status, `${method} ${url}`).toBe(403);
  }
});
it('another store is 404', async () => {
  const res = await request(app)
    .post('/stores/store-b/deletion/preview')
    .set('x-role', 'store_admin')
    .send({});
  expect(res.status).toBe(404);
});
it('schedule: Zod rejects a missing slug; the store id comes from the path, never the body', async () => {
  const bad = await request(app)
    .post('/stores/store-a/deletion')
    .set('x-role', 'store_admin')
    .send({ confirmToken: 'aaaaaaaaaaaa.bbbb' });
  expect(bad.status).toBe(400);
  const ok = await request(app)
    .post('/stores/store-a/deletion')
    .set('x-role', 'store_admin')
    .send({ confirmToken: 'aaaaaaaaaaaa.bbbb', typedSlug: 'shop-a', storeId: 'store-evil' });
  expect(ok.status).toBe(202);
  expect(m.schedule).toHaveBeenCalledWith(
    expect.objectContaining({ storeId: 'store-a', userId: OWNER }),
    expect.anything()
  );
});
it('preview refusal is 409 with the named reasons', async () => {
  m.preview.mockResolvedValue({
    ok: false,
    reasons: [{ code: 'STORE_HAS_MONEY_IN_FLIGHT', message: 'm' }],
  });
  const res = await request(app)
    .post('/stores/store-a/deletion/preview')
    .set('x-role', 'store_admin')
    .send({});
  expect(res.status).toBe(409);
  expect(res.body.error.details.reasons[0].code).toBe('STORE_HAS_MONEY_IN_FLIGHT');
});
it('export: returns the zip to the owner, 413 when over the row cap, 403 for a non-owner', async () => {
  const ok = await request(app).get('/stores/store-a/export').set('x-role', 'store_admin');
  expect(ok.status).toBe(200);
  expect(ok.headers['content-type']).toMatch(/zip/);
  expect(m.exportBundle).toHaveBeenCalledWith(
    expect.objectContaining({ storeId: 'store-a', userId: OWNER })
  );
  m.exportBundle.mockResolvedValue({ ok: false, rows: 60000, cap: 50000 });
  const big = await request(app).get('/stores/store-a/export').set('x-role', 'store_admin');
  expect(big.status).toBe(413);
  expect(big.body.error.code).toBe('EXPORT_TOO_LARGE');
});
