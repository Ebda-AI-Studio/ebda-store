/** GET /stores/:storeId/attention: tenant-scoped (every read carries the URL store id), never cached. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => {
  const state = {
    calls: [] as Array<{ model: string; where: any }>,
    store: {} as any,
  };
  const rec = (model: string, ret: unknown) => async (a: any) => {
    state.calls.push({ model, where: a?.where });
    return ret;
  };
  return { ...state, rec };
});
vi.mock('@ebda/database', () => {
  const tx = {
    storeSubscription: { findUnique: h.rec('sub', null) },
    manualPaymentClaim: { count: h.rec('claim', 1) },
  };
  return { prisma: {}, withStore: async (_id: string, fn: (t: typeof tx) => unknown) => fn(tx) };
});
vi.mock('../../apps/api/src/services/staff-invite.service', () => ({
  countPendingInvites: async (id: string) => {
    h.calls.push({ model: 'invite', where: { storeId: id } });
    return 0;
  },
}));
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeDb: async () => ({
    store: { findUnique: h.rec('store', h.store) },
    paymentConfig: {
      findMany: h.rec('pc', [
        { provider: 'instapay', settings: {}, healthStatus: 'unknown', connectionTest: null },
      ]),
    },
    product: { count: h.rec('product', 2) },
    storeTaxProfile: { findUnique: h.rec('tax', null) },
    storeWhatsAppLink: { findUnique: h.rec('wa', null) },
    shippingZone: { count: h.rec('zone', 0) },
    shippingAreaRate: { count: h.rec('rate', 0) },
  }),
}));
vi.mock('../../apps/api/src/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => true },
}));
vi.mock('../../apps/api/src/middleware/auth', () => ({
  authenticate: (req: any, _r: any, next: any) => {
    req.user = { userId: 'u', role: 'store_admin', storeId: 'store-A' };
    next();
  },
  authorize: () => (_q: any, _r: any, next: any) => next(),
}));
vi.mock('../../apps/api/src/middleware/store-access', () => ({
  requireStoreAccess: (req: any, res: any, next: any) =>
    req.params.storeId === req.user.storeId ? next() : res.status(403).json({ success: false }),
}));
vi.mock('../../apps/api/src/middleware/tenant-context', () => ({
  tenantContext: (_q: any, _r: any, next: any) => next(),
}));

import attentionRoutes from '../../apps/api/src/routes/attention.routes';

const app = express().use('/stores', attentionRoutes);

beforeEach(() => {
  h.calls.length = 0;
  h.store = {
    pendingDomain: 'shop.example',
    domainStatus: 'pending',
    emailDomainId: null,
    emailDomainVerifiedAt: null,
    taxEnabled: false,
  };
});

describe('attention route', () => {
  it('aggregates live signals for the caller store, uncached', async () => {
    const res = await request(app).get('/stores/store-A/attention');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const ids = res.body.data.items.map((i: any) => i.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'domain_unverified',
        'instapay_incomplete',
        'no_delivery_rates',
        'billing_claim_pending',
        'chat_not_connected',
      ])
    );
    expect(res.body.data.actionCount).toBe(3);
  });
  it('every read is scoped to the URL store id', async () => {
    await request(app).get('/stores/store-A/attention');
    expect(h.calls.length).toBeGreaterThan(5);
    for (const c of h.calls) expect(JSON.stringify(c.where)).toContain('store-A');
  });
  it("another store's admin is refused and nothing is read", async () => {
    const res = await request(app).get('/stores/store-B/attention');
    expect(res.status).toBe(403);
    expect(h.calls).toEqual([]);
  });
  it('a store that does not exist is a 404, not an empty list', async () => {
    h.store = null;
    const res = await request(app).get('/stores/store-A/attention');
    expect(res.status).toBe(404);
  });
});
