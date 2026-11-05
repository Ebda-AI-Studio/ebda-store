/**
 * BE:E-1 (the admin stall, Ruling LAZY-TX-3): `router.param('storeId', tenantContext)` runs BEFORE the route's own `authenticate`.
 * It used to lease a pooled client and BEGIN a 30 s transaction for every request, then hold it across the identity RPCs.
 *
 *  - an ANONYMOUS GET/HEAD (no Authorization, no Cookie) must not BEGIN at all;
 *  - an anonymous write keeps its transaction (atomicity);
 *  - an identity-service token is authenticated BEFORE the transaction opens, so no pooled client is held across an RPC;
 *  - a failed pre-check does not stop the request (the route's own `authenticate` owns the 401).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const m = vi.hoisted(() => ({
  order: [] as string[],
  runInTenantContext: vi.fn(),
  runInStoreScope: vi.fn(),
  authenticateAccounts: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  runInTenantContext: (...a: [string | undefined, () => Promise<unknown>, string?]) =>
    m.runInTenantContext(...a),
  runInStoreScope: (...a: [string, () => Promise<unknown>]) => m.runInStoreScope(...a),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/middleware/auth', () => ({
  authenticateAccounts: (...a: unknown[]) => m.authenticateAccounts(...a),
  liveIdentityMemo: () => ({}),
}));
vi.mock('@api/lib/accounts-token', () => ({
  isAccountsToken: (t: string) => t.startsWith('acct.'),
}));

import { tenantContext } from '@api/middleware/tenant-context';

const STORE = '11111111-1111-4111-8111-111111111111';

function app() {
  const r = express.Router();
  r.param('storeId', tenantContext);
  r.get('/:storeId/things', (_q, res) => {
    m.order.push('handler');
    res.json({ ok: true });
  });
  r.post('/:storeId/things', (_q, res) => {
    res.json({ ok: true });
  });
  // the public storefront namespace: the hot anonymous path keeps its one-transaction read (LAZY-TX-1/2)
  const pub = express.Router();
  pub.param('storeId', tenantContext);
  pub.get('/:storeId/things', (_q, res) => {
    res.json({ ok: true });
  });
  const a = express();
  a.use(express.json());
  a.use('/stores', r);
  a.use('/public', pub);
  return a;
}

beforeEach(() => {
  m.order.length = 0;
  m.runInTenantContext.mockReset().mockImplementation(async (_s, fn: () => Promise<unknown>) => {
    m.order.push('BEGIN');
    return fn();
  });
  m.runInStoreScope.mockReset().mockImplementation(async (_s, fn: () => Promise<unknown>) => {
    m.order.push('scope');
    return fn();
  });
  m.authenticateAccounts.mockReset().mockImplementation(async () => {
    m.order.push('identity');
    return {};
  });
});

describe('tenantContext opens the transaction lazily (BE:E-1)', () => {
  it('an anonymous GET never BEGINs: it runs in the per-query store scope', async () => {
    const res = await request(app()).get(`/stores/${STORE}/things`);
    expect(res.status).toBe(200);
    expect(m.runInTenantContext).not.toHaveBeenCalled();
    expect(m.runInStoreScope).toHaveBeenCalledTimes(1);
  });

  it('an anonymous PUBLIC storefront GET keeps its transaction (hot path, LAZY-TX-1/2)', async () => {
    await request(app()).get(`/public/${STORE}/things`);
    expect(m.runInTenantContext).toHaveBeenCalledTimes(1);
    expect(m.runInStoreScope).not.toHaveBeenCalled();
  });

  it('6 parallel anonymous GETs hold no transaction at all', async () => {
    const a = app();
    await Promise.all(Array.from({ length: 6 }, () => request(a).get(`/stores/${STORE}/things`)));
    expect(m.runInTenantContext).not.toHaveBeenCalled();
  });

  it('a request carrying a credential BEGINs exactly once', async () => {
    const res = await request(app())
      .get(`/stores/${STORE}/things`)
      .set('Authorization', 'Bearer customer-token');
    expect(res.status).toBe(200);
    expect(m.runInTenantContext).toHaveBeenCalledTimes(1);
    expect(m.authenticateAccounts).not.toHaveBeenCalled();
  });

  it('a request an upstream authenticate already identified (req.user) keeps its transaction', async () => {
    const a = express();
    a.use((req, _res, next) => {
      (req as unknown as { user: unknown }).user = { userId: 'u1', role: 'store_admin' };
      next();
    });
    const r = express.Router();
    r.param('storeId', tenantContext);
    r.get('/:storeId/things', (_q, res) => void res.json({ ok: true }));
    a.use('/stores', r);
    await request(a).get(`/stores/${STORE}/things`);
    expect(m.runInTenantContext).toHaveBeenCalledTimes(1);
    expect(m.runInStoreScope).not.toHaveBeenCalled();
  });

  it('a cookie-only request keeps the transaction', async () => {
    await request(app()).get(`/stores/${STORE}/things`).set('Cookie', 'ebda_session=x');
    expect(m.runInTenantContext).toHaveBeenCalledTimes(1);
  });

  it('an anonymous WRITE keeps its transaction (atomicity)', async () => {
    await request(app()).post(`/stores/${STORE}/things`).send({});
    expect(m.runInTenantContext).toHaveBeenCalledTimes(1);
    expect(m.runInStoreScope).not.toHaveBeenCalled();
  });

  it('an identity-service token is checked BEFORE the transaction opens', async () => {
    const res = await request(app())
      .get(`/stores/${STORE}/things`)
      .set('Authorization', 'Bearer acct.token');
    expect(res.status).toBe(200);
    expect(m.order).toEqual(['identity', 'BEGIN', 'handler']);
  });

  it('a failed pre-check does not end the request: the route authenticate owns the 401', async () => {
    m.authenticateAccounts.mockRejectedValueOnce(new Error('revoked'));
    const res = await request(app())
      .get(`/stores/${STORE}/things`)
      .set('Authorization', 'Bearer acct.token');
    expect(res.status).toBe(200);
    expect(m.runInTenantContext).toHaveBeenCalledTimes(1);
  });

  it('a non-UUID store segment still skips both lanes', async () => {
    await request(app()).get('/stores/public/things');
    expect(m.runInTenantContext).not.toHaveBeenCalled();
    expect(m.runInStoreScope).not.toHaveBeenCalled();
  });
});
