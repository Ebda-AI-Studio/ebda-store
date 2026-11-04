/**
 * #1602 — one request, one tenant transaction.
 *
 * `routes/index.ts` mounts `customersRoutes` at the bare prefix
 * `/stores/:storeId`, so its `tenantContext` opens a transaction for EVERY
 * `/stores/<uuid>/*` request. When the customers router answers nothing, the
 * request falls through to a later bare `/stores` mount whose sub-router
 * registers `router.param('storeId', tenantContext)` — coupons, bulk,
 * variants, shipping… — which opened a SECOND transaction on a second
 * connection. Commits gate the response, so the client waited on two
 * serialized COMMITs, and an empty outer COMMIT that failed turned a durable
 * write into a 500.
 *
 * This reproduces that exact router shape and counts transactions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { runInTenantContextMock } = vi.hoisted(() => ({
  runInTenantContextMock: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  runInTenantContext: (...args: [string | undefined, () => Promise<unknown>, string?]) =>
    runInTenantContextMock(...args),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { tenantContext } from '@api/middleware/tenant-context';

const STORE = '11111111-1111-4111-8111-111111111111';

function app() {
  // The customers router: mounted at the bare `/stores/:storeId` prefix,
  // answers only its own paths.
  const customers = express.Router({ mergeParams: true });
  customers.get('/customers', (_req, res) => {
    res.json({ from: 'customers' });
  });

  // A later bare-`/stores` router carrying its own param-level context, the
  // coupon/bulk/variant/shipping shape.
  const coupons = express.Router();
  coupons.param('storeId', tenantContext);
  coupons.get('/:storeId/coupons', (_req, res) => {
    res.json({ from: 'coupons' });
  });

  const a = express();
  a.use('/stores/:storeId', tenantContext, customers);
  a.use('/stores', tenantContext, coupons);
  return a;
}

describe('tenantContext — one transaction per request (#1602)', () => {
  beforeEach(() => {
    runInTenantContextMock
      .mockReset()
      .mockImplementation(
        async (_storeId: string | undefined, fn: () => Promise<unknown>, _userId?: string) => fn()
      );
  });

  it('a request that falls through the bare /stores/:storeId mount opens ONE transaction', async () => {
    const res = await request(app())
      .get(`/stores/${STORE}/coupons`)
      .set('Authorization', 'Bearer t');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ from: 'coupons' });
    expect(runInTenantContextMock).toHaveBeenCalledTimes(1);
    expect(runInTenantContextMock.mock.calls[0][0]).toBe(STORE);
  });

  it('a route the first mount does answer still opens exactly one', async () => {
    const res = await request(app())
      .get(`/stores/${STORE}/customers`)
      .set('Authorization', 'Bearer t');
    expect(res.body).toEqual({ from: 'customers' });
    expect(runInTenantContextMock).toHaveBeenCalledTimes(1);
  });

  it('separate requests do not share a transaction', async () => {
    const a = app();
    await request(a).get(`/stores/${STORE}/coupons`).set('Authorization', 'Bearer t');
    await request(a).get(`/stores/${STORE}/coupons`).set('Authorization', 'Bearer t');
    expect(runInTenantContextMock).toHaveBeenCalledTimes(2);
  });
});
