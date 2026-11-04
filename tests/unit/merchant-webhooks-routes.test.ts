/**
 * Merchant webhooks admin API: auth chain, plan gate, SSRF rejection at registration, secret shown
 * once, tenant isolation (another store's endpoint is a 404), test + resend dispatch.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

type Row = Record<string, any>;
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const E1 = '33333333-3333-4333-8333-333333333333';
const D1 = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({
  role: 'store_admin',
  denyStore: false,
  plan: 'growth' as string | null,
  endpoints: [] as Row[],
  deliveries: [] as Row[],
  authorizeArgs: [] as string[][],
  assertUrl: vi.fn(),
  dispatch: vi.fn(),
  createTest: vi.fn(),
  createResend: vi.fn(),
  audit: vi.fn(),
  calls: [] as string[],
}));

vi.mock('@ebda/database', () => {
  const match = (r: Row, w: Row) => Object.entries(w).every(([k, v]) => r[k] === v);
  const pick = (r: Row, sel?: Row) =>
    sel ? Object.fromEntries(Object.keys(sel).map(k => [k, r[k]])) : r;
  return {
    prisma: {
      webhookEndpoint: {
        findMany: async ({ where, select }: Row) =>
          h.endpoints.filter(r => match(r, where)).map(r => pick(r, select)),
        findFirst: async ({ where, select }: Row) => {
          const r = h.endpoints.find(x => match(x, where));
          return r ? pick(r, select) : null;
        },
        count: async ({ where }: Row) => {
          h.calls.push('count');
          return h.endpoints.filter(r => match(r, where)).length;
        },
        create: async ({ data, select }: Row) => {
          const row = { id: E1, active: true, consecutiveFailures: 0, ...data };
          h.endpoints.push(row);
          return pick(row, select);
        },
        updateMany: async ({ where, data }: Row) => {
          const rows = h.endpoints.filter(r => match(r, where));
          rows.forEach(r => Object.assign(r, data));
          return { count: rows.length };
        },
        deleteMany: async ({ where }: Row) => {
          const n = h.endpoints.length;
          h.endpoints = h.endpoints.filter(r => !match(r, where));
          return { count: n - h.endpoints.length };
        },
      },
      $executeRaw: async (strings: TemplateStringsArray) => {
        h.calls.push(`raw:${strings.join('?').trim()}`);
        return 1;
      },
      webhookDelivery: {
        findMany: async ({ where }: Row) => h.deliveries.filter(r => match(r, where)),
        findFirst: async ({ where, select }: Row) => {
          const r = h.deliveries.find(x => match(x, where));
          return r ? pick(r, select) : null;
        },
      },
    },
    Prisma: {
      PrismaClientKnownRequestError: class {},
      PrismaClientValidationError: class {},
      PrismaClientUnknownRequestError: class {},
      PrismaClientInitializationError: class {},
      PrismaClientRustPanicError: class {},
    },
    runInTenantContext: async (_s: string, fn: () => unknown) => fn(),
    onClosedTenantTxAccess: () => undefined,
  };
});
vi.mock('@ebda/shared', async () => await import('../../packages/shared/src/index'));
vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: h.role };
    next();
  },
  authorize: (...roles: string[]) => {
    h.authorizeArgs.push(roles);
    return (req: any, res: any, next: any) =>
      roles.includes(req.user.role) ? next() : res.status(403).json({ success: false });
  },
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, res: any, next: any) =>
    h.denyStore ? res.status(403).json({ success: false, code: 'STORE_ACCESS_DENIED' }) : next(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: h.audit,
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/services/plan-entitlements', () => ({
  getEntitlements: async () => (h.plan ? { planCode: h.plan } : null),
}));
vi.mock('@api/services/encryption.service', () => ({
  encryption: { encrypt: (s: string) => `enc(${s})`, decrypt: (s: string) => s },
}));
vi.mock('@api/lib/webhook-http', () => ({ assertWebhookUrl: h.assertUrl }));
vi.mock('@api/lib/inngest/send-after-commit', () => ({ sendEventAfterCommit: h.dispatch }));
vi.mock('@api/services/webhook.service', async () => {
  const real = await vi.importActual<any>('@api/services/webhook.service');
  return { ...real, createTestDelivery: h.createTest, createResend: h.createResend };
});
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let app: Express;
const BASE = `/api/v1/stores/${S1}/webhooks`;
const good = { url: 'https://hooks.example.com/ebda', events: ['order.created'] };
const ep = (o: Row = {}) => ({
  id: E1,
  storeId: S1,
  url: 'https://hooks.example.com/ebda',
  events: ['order.created'],
  active: true,
  secretEnc: 'SECRET-CIPHER',
  secretHint: 'abcd',
  includeCustomer: false,
  consecutiveFailures: 0,
  ...o,
});

beforeAll(async () => {
  const { default: routes } = await import('@api/routes/merchant-webhooks.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const server = express();
  server.use(express.json());
  server.use('/api/v1/stores/:storeId/webhooks', routes);
  server.use(errorHandler);
  app = server;
});
beforeEach(() => {
  h.role = 'store_admin';
  h.denyStore = false;
  h.plan = 'growth';
  h.endpoints = [];
  h.deliveries = [];
  h.assertUrl.mockReset().mockResolvedValue(new URL('https://hooks.example.com'));
  h.dispatch.mockReset().mockResolvedValue(undefined);
  h.createTest.mockReset().mockResolvedValue('t-1');
  h.createResend.mockReset().mockResolvedValue('r-1');
  h.audit.mockReset();
  h.calls = [];
});

describe('permissions', () => {
  it('only store_admin / super_admin pass the role gate; staff and customers get 403', async () => {
    for (const role of ['staff', 'customer']) {
      h.role = role;
      expect((await request(app).get(BASE)).status).toBe(403);
    }
    expect(h.authorizeArgs.at(-1)).toEqual(['store_admin', 'super_admin']);
  });
  it('a non-owner store_admin is refused by store access', async () => {
    h.denyStore = true;
    expect((await request(app).post(BASE).send(good)).status).toBe(403);
    expect(h.endpoints).toHaveLength(0);
  });
  it('plan gate: Basic and Free get 402 with an upgrade target; Growth and Business pass', async () => {
    for (const plan of ['free', 'basic', null]) {
      h.plan = plan;
      const r = await request(app).post(BASE).send(good);
      expect(r.status).toBe(402);
      expect(r.body.error.details.upgradeTo.code).toBe('growth');
    }
    for (const plan of ['growth', 'business']) {
      h.plan = plan;
      expect((await request(app).post(BASE).send(good)).status).toBe(201);
      h.endpoints = [];
    }
  });
  it('I3: on a lapsed plan the merchant can still SEE, DISABLE and DELETE (read + kill)', async () => {
    h.plan = 'basic';
    h.endpoints = [ep()];
    h.deliveries = [{ id: D1, endpointId: E1, storeId: S1 }];
    expect((await request(app).get(BASE)).status).toBe(200);
    expect((await request(app).get(`${BASE}/${E1}/deliveries`)).status).toBe(200);
    expect((await request(app).get(`${BASE}/${E1}/deliveries/${D1}`)).status).toBe(200);
    expect((await request(app).patch(`${BASE}/${E1}`).send({ active: false })).status).toBe(200);
    expect(h.endpoints[0].active).toBe(false);
    expect((await request(app).delete(`${BASE}/${E1}`)).status).toBe(200);
    expect(h.endpoints).toHaveLength(0);
  });
  it('I3: on a lapsed plan create, test, resend, rotate, re-enable and any other edit are 402', async () => {
    h.plan = 'basic';
    h.endpoints = [ep({ active: false })];
    h.deliveries = [{ id: D1, endpointId: E1, storeId: S1 }];
    const u = `${BASE}/${E1}`;
    for (const r of [
      await request(app).post(BASE).send(good),
      await request(app).post(`${u}/test`),
      await request(app).post(`${u}/deliveries/${D1}/resend`),
      await request(app).post(`${u}/rotate-secret`),
      await request(app).patch(u).send({ active: true }),
      await request(app).patch(u).send({ url: 'https://other.example.com/x' }),
      await request(app).patch(u).send({ active: false, includeCustomer: true }),
    ]) {
      expect(r.status).toBe(402);
    }
    expect(h.createTest).not.toHaveBeenCalled();
    expect(h.createResend).not.toHaveBeenCalled();
    expect(h.endpoints[0].active).toBe(false);
  });
  it('super_admin bypasses the plan gate', async () => {
    h.role = 'super_admin';
    h.plan = 'free';
    expect((await request(app).get(BASE)).status).toBe(200);
  });
});

describe('create', () => {
  it('returns the secret once and never stores it in clear', async () => {
    const r = await request(app).post(BASE).send(good);
    expect(r.status).toBe(201);
    expect(r.body.data.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(r.body.data.endpoint.secretEnc).toBeUndefined();
    expect(h.endpoints[0].secretEnc).toBe(`enc(${r.body.data.secret})`);
    expect(h.endpoints[0].storeId).toBe(S1);
    expect(h.audit).toHaveBeenCalledOnce();
    const list = await request(app).get(BASE);
    expect(JSON.stringify(list.body)).not.toContain('whsec_');
    expect(JSON.stringify(list.body)).not.toContain('SECRET-CIPHER');
  });
  it('rejects http, credentials and IP literals by shape, before any DNS', async () => {
    for (const url of [
      'http://hooks.example.com',
      'https://u:p@hooks.example.com',
      'https://10.0.0.1/x',
    ]) {
      expect(
        (
          await request(app)
            .post(BASE)
            .send({ ...good, url })
        ).status
      ).toBe(400);
    }
    expect(h.assertUrl).not.toHaveBeenCalled();
  });
  it('rejects a host that resolves to a private address (SSRF) with a stable reason', async () => {
    h.assertUrl.mockRejectedValue(new Error('SSRF_BLOCKED: host resolves to a private address'));
    const r = await request(app).post(BASE).send(good);
    expect(r.status).toBe(400);
    expect(r.body.error.code ?? r.body.code).toBe('WEBHOOK_URL_REJECTED');
    expect(h.endpoints).toHaveLength(0);
  });
  it('M4: the cap check runs under a per-store advisory lock, taken BEFORE the count', async () => {
    await request(app).post(BASE).send(good);
    const lock = h.calls.findIndex(c => c.startsWith('raw:SELECT pg_advisory_xact_lock'));
    const count = h.calls.indexOf('count');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(count);
  });
  it('caps endpoints per store', async () => {
    h.endpoints = Array.from({ length: 10 }, (_, i) => ep({ id: `x${i}` }));
    expect((await request(app).post(BASE).send(good)).status).toBe(409);
  });
  it('refuses unknown body keys (no storeId smuggling)', async () => {
    expect(
      (
        await request(app)
          .post(BASE)
          .send({ ...good, storeId: S2 })
      ).status
    ).toBe(400);
  });
});

describe('tenant isolation', () => {
  it("another store's endpoint is a 404 for every verb", async () => {
    h.endpoints = [ep({ storeId: S2 })];
    const u = `${BASE}/${E1}`;
    expect((await request(app).patch(u).send({ active: false })).status).toBe(404);
    expect((await request(app).delete(u)).status).toBe(404);
    expect((await request(app).post(`${u}/rotate-secret`)).status).toBe(404);
    expect((await request(app).post(`${u}/test`)).status).toBe(404);
    expect((await request(app).get(`${u}/deliveries`)).status).toBe(404);
    expect(h.endpoints).toHaveLength(1);
    expect(h.createTest).not.toHaveBeenCalled();
  });
  it("another store's delivery cannot be read or resent through my endpoint id", async () => {
    h.endpoints = [ep()];
    h.deliveries = [{ id: D1, endpointId: E1, storeId: S2, payload: { secret: 'x' } }];
    expect((await request(app).get(`${BASE}/${E1}/deliveries/${D1}`)).status).toBe(404);
    expect((await request(app).post(`${BASE}/${E1}/deliveries/${D1}/resend`)).status).toBe(404);
    expect(h.createResend).not.toHaveBeenCalled();
  });
});

describe('update / rotate / test / resend', () => {
  beforeEach(() => {
    h.endpoints = [ep()];
  });
  it('re-enabling re-checks the URL and resets the failure streak', async () => {
    h.endpoints = [
      ep({ active: false, disabledReason: 'consecutive_failures', consecutiveFailures: 10 }),
    ];
    const r = await request(app).patch(`${BASE}/${E1}`).send({ active: true });
    expect(r.status).toBe(200);
    expect(h.assertUrl).toHaveBeenCalled();
    expect(h.endpoints[0]).toMatchObject({
      active: true,
      disabledReason: null,
      consecutiveFailures: 0,
    });
  });
  it('a merchant switching it off records the reason', async () => {
    await request(app).patch(`${BASE}/${E1}`).send({ active: false });
    expect(h.endpoints[0]).toMatchObject({ active: false, disabledReason: 'merchant' });
  });
  it('changing the url to a private host is refused and nothing changes', async () => {
    h.assertUrl.mockRejectedValue(new Error('SSRF_BLOCKED: private'));
    const r = await request(app).patch(`${BASE}/${E1}`).send({ url: 'https://evil.example.com/x' });
    expect(r.status).toBe(400);
    expect(h.endpoints[0].url).toBe('https://hooks.example.com/ebda');
  });
  it('rotate returns a new secret once and replaces the stored cipher', async () => {
    const r = await request(app).post(`${BASE}/${E1}/rotate-secret`);
    expect(r.status).toBe(200);
    expect(h.endpoints[0].secretEnc).toBe(`enc(${r.body.data.secret})`);
    expect(h.endpoints[0].secretEnc).not.toBe('SECRET-CIPHER');
    expect(r.body.data.endpoint.secretHint).toBe(r.body.data.secret.slice(-4));
  });
  it('test event is created and dispatched after commit', async () => {
    const r = await request(app).post(`${BASE}/${E1}/test`);
    expect(r.status).toBe(202);
    expect(h.createTest).toHaveBeenCalledWith(S1, E1);
    expect(h.dispatch).toHaveBeenCalledWith(
      'webhook.test',
      { name: 'webhook/delivery.requested', data: { storeId: S1, deliveryId: 't-1' } },
      { ifUnhookable: 'drop' }
    );
  });
  it('resend dispatches the new delivery', async () => {
    h.deliveries = [{ id: D1, endpointId: E1, storeId: S1 }];
    const r = await request(app).post(`${BASE}/${E1}/deliveries/${D1}/resend`);
    expect(r.status).toBe(202);
    expect(h.createResend).toHaveBeenCalledWith(S1, D1);
    expect(h.dispatch.mock.calls[0][1].data.deliveryId).toBe('r-1');
  });
  it('delete removes only this store row', async () => {
    expect((await request(app).delete(`${BASE}/${E1}`)).status).toBe(200);
    expect(h.endpoints).toHaveLength(0);
  });
});
