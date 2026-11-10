/**
 * "Hide my store from search engines": `PUT /stores/:id/seo` accepts a boolean `hideFromSearchEngines`
 * (and nothing else in its place), hands it to the service, and `GET /stores/:id/seo` reads it back from
 * `store.settings` so the admin toggle shows the saved state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { updateSeoMock, findFirstMock } = vi.hoisted(() => ({
  updateSeoMock: vi.fn(),
  findFirstMock: vi.fn(),
}));

vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', role: 'store_admin' };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/services/store.service', () => ({
  StoreService: { updateSeo: (...a: unknown[]) => updateSeoMock(...a) },
  bustStoreCaches: vi.fn(),
}));
vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, prisma: { store: { findFirst: findFirstMock } } };
});

import storeRoutes from '@api/routes/store.routes';
import { errorHandler } from '@api/middleware/error-handler';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/stores', storeRoutes);
  a.use(errorHandler);
  return a;
}

describe('hide-from-search flag on the store SEO routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateSeoMock.mockResolvedValue({ id: 'store-1' });
  });

  it.each([true, false])('PUT passes hideFromSearchEngines=%s to the service', async value => {
    const res = await request(app())
      .put('/stores/store-1/seo')
      .send({ hideFromSearchEngines: value });
    expect(res.status).toBe(200);
    expect(updateSeoMock).toHaveBeenCalledWith(
      'store-1',
      expect.objectContaining({ hideFromSearchEngines: value })
    );
  });

  it.each(['yes', 1, null, {}])('PUT rejects a non-boolean %j', async bad => {
    const res = await request(app())
      .put('/stores/store-1/seo')
      .send({ hideFromSearchEngines: bad });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(updateSeoMock).not.toHaveBeenCalled();
  });

  it('GET reads the flag from settings, default false, without leaking the settings bag', async () => {
    findFirstMock.mockResolvedValueOnce({
      metaTitle: 'T',
      settings: { hideFromSearchEngines: true, orderInvoiceEmail: 'o@x.co' },
    });
    const on = await request(app()).get('/stores/store-1/seo');
    expect(on.body.data.hideFromSearchEngines).toBe(true);
    expect(on.body.data.settings).toBeUndefined();
    expect(JSON.stringify(on.body)).not.toContain('orderInvoiceEmail');

    findFirstMock.mockResolvedValueOnce({ metaTitle: 'T', settings: null });
    const off = await request(app()).get('/stores/store-1/seo');
    expect(off.body.data.hideFromSearchEngines).toBe(false);
  });
});
