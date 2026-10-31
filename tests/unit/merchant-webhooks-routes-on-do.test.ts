/**
 * Ruling CF-JOBS-4B (security review must-fix): the merchant-webhook admin routes and the service they call use ONE backend for
 * the gate and the action. The endpoint exists ONLY on the store's Durable Object; Postgres THROWS if any route or service touches
 * it. So the ownership check passes on the DO row, a missing endpoint is a 404 from the DO, and "test" writes its delivery to the DO.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

type Row = Record<string, any>;
const S1 = '11111111-1111-4111-8111-111111111111';
const E1 = '33333333-3333-4333-8333-333333333333';
const E2 = '55555555-5555-4555-8555-555555555555';

const h = vi.hoisted(() => {
  const match = (r: Row, w: Row) => Object.entries(w).every(([k, v]) => r[k] === v);
  return {
    match,
    endpoints: [] as Row[],
    deliveries: [] as Row[],
    dispatch: vi.fn(),
    seq: 0,
    boom: (what: string): object =>
      new Proxy(
        {},
        {
          get: (_t, p) => {
            throw new Error(`Postgres touched: ${what}.${String(p)}`);
          },
        }
      ),
  };
});
vi.mock('@ebda/database', () => ({
  prisma: h.boom('prisma'),
  Prisma: {
    PrismaClientKnownRequestError: class {},
    PrismaClientValidationError: class {},
    PrismaClientUnknownRequestError: class {},
    PrismaClientInitializationError: class {},
    PrismaClientRustPanicError: class {},
  },
  runInTenantContext: async () => {
    throw new Error('Postgres touched: runInTenantContext');
  },
  withStore: async () => {
    throw new Error('Postgres touched: withStore');
  },
  runInStoreScope: (_id: string, fn: () => unknown) => fn(),
  onClosedTenantTxAccess: () => undefined,
}));
vi.mock('@api/lib/repo-factory', () => {
  const pick = (r: Row, sel?: Row) =>
    sel ? Object.fromEntries(Object.keys(sel).map(k => [k, r[k]])) : r;
  const db = {
    webhookEndpoint: {
      findMany: async ({ where, select }: Row) =>
        h.endpoints.filter(r => h.match(r, where)).map(r => pick(r, select)),
      findFirst: async ({ where, select }: Row) => {
        const r = h.endpoints.find(x => h.match(x, where));
        return r ? pick(r, select) : null;
      },
      count: async ({ where }: Row) => h.endpoints.filter(r => h.match(r, where)).length,
    },
    webhookDelivery: {
      findMany: async ({ where, skip }: Row) =>
        h.deliveries.filter(r => h.match(r, where)).slice(skip ?? 0),
      findFirst: async ({ where }: Row) => h.deliveries.find(x => h.match(x, where)) ?? null,
    },
  };
  const writer = {
    webhookEndpoint: {
      create: async ({ data }: Row) => {
        const row = { id: E2, active: true, consecutiveFailures: 0, ...data };
        h.endpoints.push(row);
        return row;
      },
    },
    webhookDelivery: {
      create: async ({ data }: Row) => {
        const row = { id: `dl${++h.seq}`, ...data };
        h.deliveries.push(row);
        return { id: row.id };
      },
      deleteMany: async () => ({ count: 0 }),
    },
  };
  const money = {
    // the cap check and the insert are one DO section
    webhookEndpointCreate: async (a: Row) => {
      if (h.endpoints.filter(r => r.storeId === S1).length >= a.maxEndpoints)
        throw Object.assign(new Error('Webhook endpoint limit reached'), { code: 'WEBHOOK_LIMIT' });
      const row = { id: E2, storeId: S1, active: true, consecutiveFailures: 0, ...a };
      h.endpoints.push(row);
      return { id: E2 };
    },
  };
  return { storeRepo: async () => ({ backend: 'do', db, writer, money }) };
});
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin' };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: vi.fn(),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/services/plan-entitlements', () => ({
  getEntitlements: async () => ({ planCode: 'growth' }),
}));
vi.mock('@api/services/encryption.service', () => ({
  encryption: { encrypt: (s: string) => `enc(${s})`, decrypt: (s: string) => s },
}));
vi.mock('@api/lib/webhook-http', () => ({
  assertWebhookUrl: async () => new URL('https://hooks.example.com'),
}));
vi.mock('@api/lib/inngest/send-after-commit', () => ({ sendEventAfterCommit: h.dispatch }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let app: Express;
const BASE = `/api/v1/stores/${S1}/webhooks`;

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
  h.endpoints.length = 0;
  h.deliveries.length = 0;
  h.dispatch.mockReset().mockResolvedValue(undefined);
  h.seq = 0;
  h.endpoints.push({
    id: E1,
    storeId: S1,
    url: 'https://hooks.example.com/ebda',
    events: ['order.created'],
    active: true,
    secretEnc: 'c',
    secretHint: 'abcd',
    includeCustomer: false,
    consecutiveFailures: 0,
  });
});

describe('merchant webhook routes on a DO store', () => {
  it('test-send: the endpoint exists only on the DO, the gate passes there and the delivery is written there', async () => {
    const res = await request(app).post(`${BASE}/${E1}/test`);
    expect(res.status).toBe(202);
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0]).toMatchObject({ endpointId: E1, storeId: S1, isTest: true });
    expect(res.body.data.deliveryId).toBe(h.deliveries[0].id);
    expect(h.dispatch).toHaveBeenCalledOnce();
  });

  it('an endpoint that is NOT on the DO is a 404 from the DO and writes nothing', async () => {
    h.endpoints.length = 0;
    const res = await request(app).post(`${BASE}/${E1}/test`);
    expect(res.status).toBe(404);
    expect(h.deliveries).toHaveLength(0);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('list and create read and write the DO (no advisory lock, no Postgres)', async () => {
    const list = await request(app).get(BASE);
    expect(list.status).toBe(200);
    expect(list.body.data.endpoints).toHaveLength(1);
    const made = await request(app)
      .post(BASE)
      .send({ url: 'https://hooks.example.com/new', events: ['order.created'] });
    expect(made.status).toBe(201);
    expect(h.endpoints.map(e => e.id)).toContain(E2);
  });

  it('create is refused at the cap by the DO section, after the URL check', async () => {
    for (let i = 0; i < 20; i++) h.endpoints.push({ id: `x${i}`, storeId: S1 });
    const res = await request(app)
      .post(BASE)
      .send({ url: 'https://hooks.example.com/new', events: ['order.created'] });
    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe('WEBHOOK_LIMIT');
  });
});

describe('createTestDelivery checks ownership on the SAME client it writes with (Ruling CF-WEBHOOK-2)', () => {
  it('an endpoint that is not on the DO is refused by the service itself, whatever the caller checked', async () => {
    h.endpoints.length = 0;
    const { createTestDelivery } = await import('@api/services/webhook.service');
    await expect(createTestDelivery(S1, E1)).rejects.toThrow('WEBHOOK_ENDPOINT_NOT_FOUND');
    expect(h.deliveries).toHaveLength(0);
  });

  it("another store's endpoint id is refused (the check names the store)", async () => {
    h.endpoints.push({ id: E2, storeId: '99999999-9999-4999-8999-999999999999' });
    const { createTestDelivery } = await import('@api/services/webhook.service');
    await expect(createTestDelivery(S1, E2)).rejects.toThrow('WEBHOOK_ENDPOINT_NOT_FOUND');
    expect(h.deliveries).toHaveLength(0);
  });

  it('an owned endpoint gets its delivery on the DO', async () => {
    const { createTestDelivery } = await import('@api/services/webhook.service');
    const id = await createTestDelivery(S1, E1);
    expect(h.deliveries[0]).toMatchObject({ id, endpointId: E1, isTest: true });
  });
});
