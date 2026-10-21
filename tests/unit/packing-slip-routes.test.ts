/**
 * Packing slip routes: staff with orders:read only, tenant-scoped from the URL
 * (never the body), bulk capped at 100, inputs validated at the edge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const generate = vi.fn();
const perms: string[] = [];
vi.mock('@api/services/packing-slip.service', () => ({
  PACKING_SLIP_MAX_ORDERS: 100,
  PackingSlipService: { generate: (...a: unknown[]) => generate(...a) },
}));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, res: any, next: any) => {
    const role = req.header('x-role');
    if (!role) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
    req.user = { userId: 'u1', role };
    next();
  },
  authorize:
    (...roles: string[]) =>
    (req: any, res: any, next: any) =>
      roles.includes(req.user.role)
        ? next()
        : res.status(403).json({ success: false, error: { code: 'FORBIDDEN' } }),
}));
const accessStores: string[] = [];
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (req: any, res: any, next: any) => {
    accessStores.push(req.params.storeId);
    return req.header('x-deny-store')
      ? res.status(403).json({ success: false, error: { code: 'FORBIDDEN' } })
      : next();
  },
}));
vi.mock('@api/middleware/rbac', () => ({
  requirePermission: (permission: string) => {
    perms.push(permission);
    return (req: any, res: any, next: any) =>
      req.header('x-no-perm')
        ? res.status(403).json({ success: false, error: { code: 'FORBIDDEN' } })
        : next();
  },
}));

const STORE = '3f2a91c4-7b1e-4d0a-9c55-0e8a1f2b3c4d';
const O1 = '11111111-1111-4111-8111-111111111111';
let app: express.Express;

beforeEach(async () => {
  generate.mockReset().mockResolvedValue('<html>slip</html>');
  accessStores.length = 0;
  if (!app) {
    const { default: router } = await import('@api/routes/packing-slip.routes');
    const { errorHandler } = await import('@api/middleware/error-handler');
    app = express();
    app.use(express.json());
    app.use('/stores/:storeId/orders', router);
    app.use(errorHandler);
  }
});

describe('GET /:orderId/packing-slip', () => {
  it('is gated by orders:read', () => {
    expect(perms).toContain('orders:read');
  });
  it('401 without a session, 403 for a customer, 403 without store access or the permission', async () => {
    const url = `/stores/${STORE}/orders/${O1}/packing-slip`;
    expect((await request(app).get(url)).status).toBe(401);
    expect((await request(app).get(url).set('x-role', 'customer')).status).toBe(403);
    expect(
      (await request(app).get(url).set('x-role', 'staff').set('x-deny-store', '1')).status
    ).toBe(403);
    expect((await request(app).get(url).set('x-role', 'staff').set('x-no-perm', '1')).status).toBe(
      403
    );
    expect(generate).not.toHaveBeenCalled();
  });
  it('staff get the slip: scoped to the URL store, A4 + order locale by default, html, no caching', async () => {
    const res = await request(app)
      .get(`/stores/${STORE}/orders/${O1}/packing-slip`)
      .set('x-role', 'staff');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(generate).toHaveBeenCalledWith(STORE, [O1], { size: 'a4', locale: undefined });
  });
  it('size and locale from the query; bad values and non-uuid ids are 400', async () => {
    await request(app)
      .get(`/stores/${STORE}/orders/${O1}/packing-slip?size=label&locale=ar`)
      .set('x-role', 'store_admin');
    expect(generate).toHaveBeenCalledWith(STORE, [O1], { size: 'label', locale: 'ar' });
    expect(
      (
        await request(app)
          .get(`/stores/${STORE}/orders/${O1}/packing-slip?size=a3`)
          .set('x-role', 'staff')
      ).status
    ).toBe(400);
    expect(
      (await request(app).get(`/stores/${STORE}/orders/nope/packing-slip`).set('x-role', 'staff'))
        .status
    ).toBe(400);
  });
});

describe('POST /packing-slips (bulk)', () => {
  const url = `/stores/${STORE}/orders/packing-slips`;
  it('same guards; the store comes from the URL, never the body', async () => {
    expect(
      (
        await request(app)
          .post(url)
          .send({ orderIds: [O1] })
      ).status
    ).toBe(401);
    expect(
      (
        await request(app)
          .post(url)
          .set('x-role', 'customer')
          .send({ orderIds: [O1] })
      ).status
    ).toBe(403);
    expect(generate).not.toHaveBeenCalled();
    const res = await request(app)
      .post(url)
      .set('x-role', 'staff')
      .send({ orderIds: [O1], size: 'label', storeId: 'evil-store' });
    expect(res.status).toBe(400); // strict body: a smuggled storeId is refused, not honoured
    const ok = await request(app)
      .post(url)
      .set('x-role', 'staff')
      .send({ orderIds: [O1], size: 'label' });
    expect(ok.status).toBe(200);
    expect(generate).toHaveBeenCalledWith(STORE, [O1], { size: 'label', locale: undefined });
    expect(accessStores.every(s => s === STORE)).toBe(true);
  });
  it('rejects 0, more than 100, and non-uuid ids at the edge', async () => {
    const many = Array.from(
      { length: 101 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    );
    for (const orderIds of [[], many, ['x'], 'a']) {
      expect((await request(app).post(url).set('x-role', 'staff').send({ orderIds })).status).toBe(
        400
      );
    }
    const hundred = many.slice(0, 100);
    expect(
      (await request(app).post(url).set('x-role', 'staff').send({ orderIds: hundred })).status
    ).toBe(200);
  });
});

describe('mounting', () => {
  it('is mounted under the orders path, behind the same orderRouteContext, before the order router', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../apps/api/src/routes/index.ts', import.meta.url), 'utf8');
    const slip = src.indexOf("router.use('/stores/:storeId/orders', orderRouteContext, packingSlipRoutes)");
    const orders = src.indexOf("router.use('/stores/:storeId/orders', orderRouteContext, orderRoutes)");
    expect(slip).toBeGreaterThan(0);
    expect(slip).toBeLessThan(orders);
  });
});
