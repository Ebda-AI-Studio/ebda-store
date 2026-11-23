/**
 * SELF-SERVICE gaps A15 + A17: a store_admin deletes a custom page of their own store and runs the stock
 * "scan now" once an hour; legal pages stay protected; other roles are refused; super_admin keeps the override.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const m = vi.hoisted(() => ({ remove: vi.fn(), send: vi.fn() }));

vi.mock('@api/middleware/auth', async () => {
  const real = await vi.importActual<typeof import('@api/middleware/auth')>('@api/middleware/auth');
  return {
    ...real,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: 'u1', role: req.header('x-role') ?? 'store_admin' };
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
vi.mock('@api/services/pages.service', () => ({ PagesService: { remove: m.remove } }));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: m.send } }));

let app: Express;
beforeAll(async () => {
  const pages = (await import('@api/routes/pages.routes')).default;
  const smart = await import('@api/routes/smart-layer.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/', pages);
  app.use('/stores', smart.default);
  app.use(errorHandler as any);
});
beforeEach(() => {
  m.remove.mockReset().mockResolvedValue(undefined);
  m.send.mockReset().mockResolvedValue(undefined);
});

describe('A15 merchant deletes a custom page', () => {
  it('store_admin deletes a custom page of their own store', async () => {
    const res = await request(app)
      .delete('/stores/store-a/pages/our-story')
      .set('x-role', 'store_admin');
    expect(res.status).toBe(200);
    expect(m.remove).toHaveBeenCalledWith('store-a', 'our-story');
  });
  it.each(['privacy', 'terms', 'Shipping'])(
    'store_admin cannot delete the legal page %s',
    async slug => {
      const res = await request(app)
        .delete(`/stores/store-a/pages/${slug}`)
        .set('x-role', 'store_admin');
      expect(res.status).toBe(403);
      expect(m.remove).not.toHaveBeenCalled();
    }
  );
  it('super_admin keeps the override on legal pages', async () => {
    const res = await request(app)
      .delete('/stores/store-a/pages/privacy')
      .set('x-role', 'super_admin');
    expect(res.status).toBe(200);
  });
  it('another store is 404 and nothing is deleted', async () => {
    const res = await request(app)
      .delete('/stores/store-b/pages/our-story')
      .set('x-role', 'store_admin');
    expect(res.status).toBe(404);
    expect(m.remove).not.toHaveBeenCalled();
  });
  it('a customer is refused', async () => {
    const res = await request(app)
      .delete('/stores/store-a/pages/our-story')
      .set('x-role', 'customer');
    expect(res.status).toBe(403);
    expect(m.remove).not.toHaveBeenCalled();
  });
});

describe('A17 merchant "scan now"', () => {
  it.each(['reorder', 'low-stock', 'deadstock'])(
    'store_admin queues the %s scan for their own store',
    async kind => {
      const res = await request(app)
        .post(`/stores/store-a/stock/${kind}-scan/run-now`)
        .set('x-role', 'store_admin');
      expect(res.status).toBe(202);
      expect(m.send).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ storeId: 'store-a', requestedBy: 'u1' }),
        })
      );
    }
  );
  it('another store is 404 and no scan is queued', async () => {
    const res = await request(app)
      .post('/stores/store-b/stock/reorder-scan/run-now')
      .set('x-role', 'store_admin');
    expect(res.status).toBe(404);
    expect(m.send).not.toHaveBeenCalled();
  });
  it('a customer is refused', async () => {
    const res = await request(app)
      .post('/stores/store-a/stock/reorder-scan/run-now')
      .set('x-role', 'customer');
    expect(res.status).toBe(403);
    expect(m.send).not.toHaveBeenCalled();
  });
});

describe('A17 limiter', () => {
  it('lets a store_admin through once per hour per store and never limits super_admin', async () => {
    const { createScanNowLimiter } = await import('@api/middleware/scan-now-limiter');
    const lim = createScanNowLimiter('t', { skip: (req: any) => req.user?.role === 'super_admin' });
    const a = express();
    a.use((req: any, _r, n) => {
      req.user = { role: req.header('x-role') };
      n();
    });
    a.post('/:storeId', lim, (_q, r) => {
      r.status(202).json({});
    });
    const post = (s: string, role: string) => request(a).post(`/${s}`).set('x-role', role);
    expect((await post('limit-s1', 'store_admin')).status).toBe(202);
    expect((await post('limit-s1', 'store_admin')).status).toBe(429);
    expect((await post('limit-s2', 'store_admin')).status).toBe(202);
    expect((await post('limit-s1', 'super_admin')).status).toBe(202);
    expect((await post('limit-s1', 'super_admin')).status).toBe(202);
  });
});
