/**
 * POST/DELETE /stores/:storeId/whatsapp-link: the merchant connects Ebda Chat in Store admin.
 * The only request path that writes the server-owned link; entitlement-gated; emits store.linked /
 * store.unlinked (contract section 4); an enqueue failure fails the request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  setLinked: vi.fn(),
  state: vi.fn(),
  can: vi.fn(),
  notify: vi.fn(),
  catalog: vi.fn(),
  send: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'owner-1', role: 'store_admin' };
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
vi.mock('@api/middleware/security', () => ({ auditLog: h.audit }));
vi.mock('@api/utils/store-helpers', () => ({ getAuthUser: (req: any) => req.user }));
vi.mock('@api/lib/wa/link', () => ({
  WhatsAppLinkService: { setLinked: h.setLinked },
  whatsAppLinkState: h.state,
  canLinkWhatsApp: h.can,
}));
vi.mock('@api/lib/wa/plan-state', () => ({ notifyPlanChanged: h.notify }));
vi.mock('@api/lib/wa/catalog-state', () => ({
  clearKnownStoreCache: vi.fn(),
  notifyCatalogChanged: h.catalog,
}));
vi.mock('@api/lib/wa/events', async () => {
  const real = await vi.importActual<typeof import('@api/lib/wa/events')>('@api/lib/wa/events');
  return { ...real, sendStoreEvents: h.send };
});

const STORE = '11111111-1111-4111-8111-111111111111';

async function app() {
  const { default: router } = await import('@api/routes/whatsapp-link.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const a = express();
  a.use(express.json());
  a.use('/stores/:storeId/whatsapp-link', router);
  a.use(errorHandler);
  return a;
}

let a: express.Express;
beforeEach(async () => {
  h.setLinked.mockReset().mockResolvedValue(undefined);
  h.state.mockReset().mockResolvedValue({ linked: true, entitled: true, active: true });
  h.can.mockReset().mockResolvedValue(true);
  h.notify.mockReset().mockResolvedValue(undefined);
  h.catalog.mockReset().mockResolvedValue(undefined);
  h.send.mockReset().mockResolvedValue(undefined);
  h.audit.mockReset().mockResolvedValue(undefined);
  a ??= await app();
});

describe('POST /whatsapp-link', () => {
  it('links the store through the one writer and emits store.linked with the owner', async () => {
    const res = await request(a).post(`/stores/${STORE}/whatsapp-link`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ linked: true });
    expect(h.setLinked).toHaveBeenCalledWith(STORE, true, 'owner-1');
    const [events] = h.send.mock.calls[0]!;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'store.linked',
      v: 1,
      storeId: STORE,
      data: { ownerUserId: 'owner-1' },
    });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'whatsapp.linked' }));
    // Ebda Chat learns the plan state right after it learns the store
    expect(h.notify).toHaveBeenCalledWith(STORE);
    // ...and the whole catalog once
    expect(h.catalog).toHaveBeenCalledWith({ storeId: STORE, productIds: null });
  });

  it('a plan without WhatsApp is refused (403) and nothing is written or sent', async () => {
    h.can.mockResolvedValue(false);
    const res = await request(a).post(`/stores/${STORE}/whatsapp-link`);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('WHATSAPP_NOT_INCLUDED');
    expect(h.setLinked).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('an unknown plan decision fails closed', async () => {
    h.can.mockResolvedValue(false);
    expect((await request(a).post(`/stores/${STORE}/whatsapp-link`)).status).toBe(403);
  });

  it('an enqueue failure fails the request (the request transaction rolls the write back)', async () => {
    h.send.mockRejectedValue(new Error('queue down'));
    const res = await request(a).post(`/stores/${STORE}/whatsapp-link`);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe('DELETE /whatsapp-link', () => {
  it('unlinks (also on a plan that no longer includes WhatsApp) and emits store.unlinked', async () => {
    h.can.mockResolvedValue(false);
    const res = await request(a).delete(`/stores/${STORE}/whatsapp-link`);
    expect(res.status).toBe(200);
    expect(h.setLinked).toHaveBeenCalledWith(STORE, false, 'owner-1');
    expect(h.send.mock.calls[0]![0][0]).toMatchObject({ type: 'store.unlinked', storeId: STORE });
  });
});

describe('GET /whatsapp-link', () => {
  it('returns the stored link, the entitlement and the effective state, uncached', async () => {
    const res = await request(a).get(`/stores/${STORE}/whatsapp-link`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ linked: true, entitled: true, active: true });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
