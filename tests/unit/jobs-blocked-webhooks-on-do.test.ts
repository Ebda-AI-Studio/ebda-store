/**
 * Ruling CF-JOBS-4B: the three merchant-webhook jobs (fan-out, deliver, daily purge) for a store on its Durable Object. Endpoints
 * and the delivery log are in-memory stand-ins for the DO tables behind the DO client/writer, Postgres THROWS if reached, the
 * `Store` row is the platform mock. Double fire: a replayed fan-out creates no second delivery, a re-run of a delivered
 * attempt does not POST again, a second purge deletes nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DO_STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const h = vi.hoisted(() => {
  const match = (row: Record<string, any>, where: Record<string, any>): boolean =>
    Object.entries(where ?? {}).every(([k, v]) => {
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('in' in v) return v.in.includes(row[k]);
        if ('lt' in v) return row[k] < v.lt;
      }
      return row[k] === v;
    });
  return {
    match,
    endpoints: [] as Array<Record<string, any>>,
    deliveries: [] as Array<Record<string, any>>,
    posts: [] as Array<{ url: string; eventId: string }>,
    postOk: true,
    seq: 0,
    sent: [] as unknown[],
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
vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: h.boom('prisma'),
    extra: {
      withStore: async (_id: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          store: {
            findUnique: async () => ({ name: 'Dahab', owner: { email: 'o@example.com' } }),
          },
        }),
      runInTenantContext: async () => {
        throw new Error('Postgres touched: runInTenantContext');
      },
      runInStoreScope: (_id: string, fn: () => unknown) => fn(),
      storeDirectory: async () => [],
    },
  })
);
vi.mock('@api/lib/repo-factory', () => {
  const delegate = (
    rows: Array<Record<string, any>>,
    prefix: string,
    extra: Record<string, any> = {}
  ) => ({
    findMany: async (a: { where?: Record<string, any>; skip?: number } = {}) =>
      rows.filter(r => h.match(r, a.where ?? {})).slice(a.skip ?? 0),
    findFirst: async (a: { where: Record<string, any> }) => {
      const r = rows.find(x => h.match(x, a.where));
      if (!r) return null;
      return extra.attach ? extra.attach(r) : r;
    },
    count: async (a: { where: Record<string, any> }) =>
      rows.filter(r => h.match(r, a.where)).length,
    create: async (a: { data: Record<string, any> }) => {
      if (
        a.data.dedupeKey &&
        rows.some(r => r.endpointId === a.data.endpointId && r.dedupeKey === a.data.dedupeKey)
      )
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      const row = {
        id: `${prefix}${++h.seq}`,
        status: 'pending',
        attempts: 0,
        isTest: false,
        createdAt: new Date(),
        ...a.data,
      };
      rows.push(row);
      return { id: row.id };
    },
    updateMany: async (a: { where: Record<string, any>; data: Record<string, any> }) => {
      const hit = rows.filter(r => h.match(r, a.where));
      for (const r of hit) {
        const { consecutiveFailures, ...rest } = a.data;
        Object.assign(r, rest);
        if (consecutiveFailures?.increment) r.consecutiveFailures += consecutiveFailures.increment;
        else if (typeof consecutiveFailures === 'number')
          r.consecutiveFailures = consecutiveFailures;
      }
      return { count: hit.length };
    },
    deleteMany: async (a: { where: Record<string, any> }) => {
      const hit = rows.filter(r => h.match(r, a.where));
      for (const r of hit) rows.splice(rows.indexOf(r), 1);
      return { count: hit.length };
    },
  });
  const endpoint = delegate(h.endpoints, 'ep');
  const delivery = delegate(h.deliveries, 'dl', {
    attach: (r: Record<string, any>) => ({
      ...r,
      endpoint: h.endpoints.find(e => e.id === r.endpointId),
    }),
  });
  const db = {
    webhookEndpoint: {
      findMany: endpoint.findMany,
      findFirst: endpoint.findFirst,
      count: endpoint.count,
    },
    webhookDelivery: { findMany: delivery.findMany, findFirst: delivery.findFirst },
    product: {
      findFirst: async () => ({
        id: 'p1',
        name: 'Lamp',
        nameAr: null,
        slug: 'lamp',
        sku: 'L1',
        price: 100,
        status: 'active',
      }),
    },
  };
  const writer = {
    webhookEndpoint: { updateMany: endpoint.updateMany },
    webhookDelivery: {
      create: delivery.create,
      updateMany: delivery.updateMany,
      deleteMany: delivery.deleteMany,
    },
  };
  return { storeRepo: async () => ({ backend: 'do', db, writer }), storeDb: async () => db };
});
vi.mock('@api/lib/webhook-http', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/webhook-http')>()),
  postWebhook: async (a: { url: string; eventId: string }) => {
    h.posts.push({ url: a.url, eventId: a.eventId });
    return h.postOk
      ? { ok: true, status: 200, snippet: 'ok', error: null, durationMs: 5 }
      : { ok: false, status: 500, snippet: null, error: 'http_500', durationMs: 5 };
  },
}));
vi.mock('@api/services/encryption.service', () => ({ encryption: { decrypt: (s: string) => s } }));
vi.mock('@api/services/plan-entitlements', () => ({
  getEntitlements: async () => ({ planCode: 'growth', status: 'active' }),
}));
vi.mock('@api/services/email.service', () => ({
  EmailService: { sendWebhookDisabledNotice: vi.fn() },
}));
vi.mock('@api/services/socket.service', () => ({ socketService: { notifyStore: vi.fn() } }));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    createFunction: (options: unknown, handler: unknown) => ({ options, handler }),
    send: vi.fn(),
  },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  runWebhookFanout,
  webhookDeliveryPurge,
  webhookDeliver,
} from '@api/lib/inngest/functions/webhook-delivery';
import { PORTED_JOBS } from '@api/lib/jobs/job-data';
import { ALARM_READY } from '@api/lib/jobs/alarm-flag';
import { decideRunForStore } from '@api/lib/jobs/do-guard';

const step = {
  run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => {
    const v = await fn();
    return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
  },
  sleep: async () => undefined,
  sendEvent: async (_id: string, e: unknown) => void h.sent.push(e),
};
type Handler = { handler: (a: unknown) => Promise<any> };

beforeEach(() => {
  h.endpoints.length = 0;
  h.deliveries.length = 0;
  h.posts.length = 0;
  h.sent.length = 0;
  h.seq = 0;
  h.postOk = true;
  h.endpoints.push({
    id: 'ep1',
    storeId: DO_STORE,
    url: 'https://merchant.example/hook',
    secretEnc: 'sek',
    active: true,
    includeCustomer: false,
    events: ['product.created', 'product.updated'],
    consecutiveFailures: 0,
  });
  vi.stubEnv('JOBS_ON_DO', '1');
  vi.stubEnv('STORE_DO_ENABLED_IDS', DO_STORE);
});

describe('the webhook jobs are ported', () => {
  it.each(['webhook-fanout', 'webhook-deliver', 'webhook-delivery-purge-daily'])('%s', id => {
    expect(PORTED_JOBS.has(id)).toBe(true);
    expect(decideRunForStore({ id } as never, DO_STORE)).toEqual({ run: true });
  });
  it('the purge is alarm-armed', () =>
    expect(ALARM_READY.has('webhook-delivery-purge-daily')).toBe(true));
});

describe('webhook-fanout on a DO store', () => {
  const ev = {
    name: 'product.upserted',
    id: 'src1',
    data: { storeId: DO_STORE, productId: 'p1', op: 'create' },
  };

  it('creates one delivery for the subscribed endpoint and dispatches it', async () => {
    const out = await runWebhookFanout(step as never, ev);
    expect(out).toEqual({ deliveries: 1 });
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0]).toMatchObject({
      endpointId: 'ep1',
      eventType: 'product.created',
      storeId: DO_STORE,
    });
    expect(h.sent).toHaveLength(1);
  });

  it('double fire: the replay creates no second delivery', async () => {
    await runWebhookFanout(step as never, ev);
    const again = await runWebhookFanout(step as never, ev);
    expect(again).toEqual({ deliveries: 0 });
    expect(h.deliveries).toHaveLength(1);
  });

  it('an endpoint not subscribed to the event gets nothing', async () => {
    h.endpoints[0].events = ['order.created'];
    expect(await runWebhookFanout(step as never, ev)).toEqual({ deliveries: 0 });
    expect(h.deliveries).toHaveLength(0);
  });
});

describe('webhook-deliver on a DO store', () => {
  const deliver = (id = 'dl1') =>
    (webhookDeliver as unknown as Handler).handler({
      event: { name: 'webhook/delivery.requested', data: { storeId: DO_STORE, deliveryId: id } },
      step,
    });
  beforeEach(() => {
    h.deliveries.push({
      id: 'dl1',
      storeId: DO_STORE,
      endpointId: 'ep1',
      eventId: 'evt1',
      eventType: 'product.created',
      payload: { a: 1 },
      isTest: false,
      status: 'pending',
      attempts: 0,
    });
  });

  it('POSTs once, marks success, resets the endpoint health; a double fire does not POST again', async () => {
    h.endpoints[0].consecutiveFailures = 2;
    expect(await deliver()).toMatchObject({ decision: 'success' });
    expect(h.deliveries[0]).toMatchObject({ status: 'success', attempts: 1, responseStatus: 200 });
    expect(h.endpoints[0].consecutiveFailures).toBe(0);
    expect(await deliver()).toMatchObject({ decision: 'skipped' });
    expect(h.posts).toHaveLength(1);
  });

  it('after the last failed attempt the endpoint counts one failure and trips off at the limit', async () => {
    h.postOk = false;
    h.endpoints[0].consecutiveFailures = 9;
    const out = await deliver();
    expect(out).toMatchObject({ decision: 'failed', endpointDisabled: true });
    expect(h.endpoints[0]).toMatchObject({ active: false, disabledReason: 'consecutive_failures' });
  });
});

describe('webhook-delivery-purge-daily on a DO store', () => {
  it('purges the store log on its alarm; the second run finds nothing', async () => {
    h.deliveries.push(
      { id: 'old', storeId: DO_STORE, createdAt: new Date(Date.now() - 400 * 86_400_000) },
      { id: 'new', storeId: DO_STORE, createdAt: new Date() }
    );
    const alarm = { name: 'x', data: { alarm: true, storeId: DO_STORE } };
    const run = () => (webhookDeliveryPurge as unknown as Handler).handler({ event: alarm, step });
    expect(await run()).toEqual({ count: 1, failed: 0 });
    expect(await run()).toEqual({ count: 0, failed: 0 });
    expect(h.deliveries.map(d => d.id)).toEqual(['new']);
  });
});
