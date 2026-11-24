/**
 * #776 review: the carrier PUT asks for the confirm step only on the OFF -> ON transition (like payment-settings). A
 * store_admin who saves a setting on a carrier that is ALREADY on, re-sending `enabled: true`, must not be refused;
 * turning an OFF (or unknown) carrier on still gets 409 CONFIRMATION_REQUIRED. super_admin keeps the override.
 * Driver proven: the real carrier router on express with the carrier service stubbed (no DB, no DO).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  configs: [] as Array<{ carrier: string; enabled: boolean }>,
  upsert: vi.fn(),
  role: 'store_admin',
}));

vi.mock('@api/middleware/auth', async () => {
  const real = await vi.importActual<object>('@api/middleware/auth');
  return {
    ...real,
    authenticate: (req: any, _r: any, next: any) => {
      req.user = { userId: 'u1', role: h.role, email: 'o@test.local' };
      next();
    },
    authorize: () => (_q: any, _r: any, next: any) => next(),
    rejectImpersonated: (_q: any, _r: any, next: any) => next(),
  };
});
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_q: any, _r: any, next: any) => next(),
  checkStoreAccess: async () => true,
}));
vi.mock('@api/middleware/tenant-context', () => ({
  shippingCarrierRouteContext: (_q: any, _r: any, next: any) => next(),
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_q: any, _r: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', async () => {
  const real = await vi.importActual<Record<string, unknown>>('@api/middleware/security');
  return { ...real, auditLog: vi.fn(async () => undefined) };
});
vi.mock('@api/services/shipping-carrier.service', () => ({
  shippingCarrierService: {
    getPublicCarrierConfigs: async () => h.configs,
    upsertCarrierConfig: h.upsert,
    testConnection: vi.fn(),
  },
}));

let app: express.Express;
beforeAll(async () => {
  const router = (await import('@api/routes/shipping-carrier.routes')).default;
  app = express();
  app.use(express.json());
  app.use('/stores', router);
  app.use((await import('@api/middleware/error-handler')).errorHandler);
});
beforeEach(() => {
  h.role = 'store_admin';
  h.configs = [];
  h.upsert.mockReset();
  h.upsert.mockResolvedValue({
    config: { id: 'c1', enabled: true, testMode: true },
    changed: [],
    disabledUntilRetested: false,
  });
});

const put = (body: object) =>
  request(app).put('/stores/s1/shipping-carriers/configs/bosta').send(body);

describe('carrier PUT enabled:true', () => {
  it('a carrier that is already ON: a settings save re-sending enabled:true is not refused', async () => {
    h.configs = [{ carrier: 'bosta', enabled: true }];
    const res = await put({ enabled: true, settings: { defaultWeightKg: 1 } });
    expect(res.status).toBe(200);
    expect(h.upsert).toHaveBeenCalledTimes(1);
  });

  it('a carrier that is OFF: turning it on needs the confirm step (409, nothing written)', async () => {
    h.configs = [{ carrier: 'bosta', enabled: false }];
    const res = await put({ enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('no config row yet counts as OFF: refused', async () => {
    const res = await put({ enabled: true });
    expect(res.status).toBe(409);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('super_admin keeps the override on an OFF carrier', async () => {
    h.role = 'super_admin';
    h.configs = [{ carrier: 'bosta', enabled: false }];
    expect((await put({ enabled: true })).status).toBe(200);
  });
});
