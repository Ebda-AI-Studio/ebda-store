/**
 * Webhook fan-out, retry schedule, auto-disable and tenant scoping, against an in-memory fake of
 * the two tables (every query must carry the ambient storeId at the top level, like the tenant guard).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = Record<string, any>;
const db = vi.hoisted(() => ({
  endpoints: [] as Row[],
  deliveries: [] as Row[],
  ambient: 's1',
  post: vi.fn(),
}));

vi.mock('@ebda/database', () => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(m: string, o: { code: string }) {
      super(m);
      this.code = o.code;
    }
  }
  const need = (where: Row) => {
    // Postgres: after a failed statement the transaction is aborted until a ROLLBACK TO SAVEPOINT.
    if (db.aborted) throw new Error('25P02 current transaction is aborted');
    if (where.storeId !== db.ambient)
      throw new Error(`TenantScopeViolation: ${JSON.stringify(where)}`);
  };
  const match = (r: Row, w: Row) =>
    Object.entries(w).every(([k, v]) => {
      if (v && typeof v === 'object' && 'has' in v) return (r[k] as string[]).includes(v.has);
      if (v && typeof v === 'object' && 'in' in v) return v.in.includes(r[k]);
      return r[k] === v;
    });
  let n = 0;
  const prisma = {
    webhookEndpoint: {
      findMany: async ({ where }: Row) => (need(where), db.endpoints.filter(r => match(r, where))),
      findFirst: async ({ where }: Row) => (
        need(where),
        db.endpoints.find(r => match(r, where)) ?? null
      ),
      updateMany: async ({ where, data }: Row) => {
        need(where);
        const rows = db.endpoints.filter(r => match(r, where));
        for (const r of rows)
          for (const [k, v] of Object.entries(data))
            r[k] =
              v && typeof v === 'object' && 'increment' in (v as Row)
                ? r[k] + (v as Row).increment
                : v;
        return { count: rows.length };
      },
    },
    webhookDelivery: {
      create: async ({ data }: Row) => {
        need(data);
        if (
          data.dedupeKey &&
          db.deliveries.some(
            d => d.endpointId === data.endpointId && d.dedupeKey === data.dedupeKey
          )
        ) {
          db.aborted = true;
          throw new PrismaClientKnownRequestError('dup', { code: 'P2002' });
        }
        const row = {
          id: `d${++n}`,
          createdAt: new Date(Date.now() + n),
          status: 'pending',
          attempts: 0,
          dedupeKey: null,
          ...data,
        };
        db.deliveries.push(row);
        return row;
      },
      findFirst: async ({ where }: Row) => {
        need(where);
        const d = db.deliveries.find(r => match(r, where));
        return d ? { ...d, endpoint: db.endpoints.find(e => e.id === d.endpointId) } : null;
      },
      findMany: async ({ where, skip = 0 }: Row) => {
        need(where);
        return db.deliveries
          .filter(r => match(r, where))
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(skip);
      },
      deleteMany: async ({ where }: Row) => {
        need(where);
        const gone = db.deliveries.filter(r => match(r, where));
        db.deliveries = db.deliveries.filter(r => !gone.includes(r));
        return { count: gone.length };
      },
      updateMany: async ({ where, data }: Row) => {
        need(where);
        const rows = db.deliveries.filter(r => match(r, where));
        rows.forEach(r => Object.assign(r, data));
        return { count: rows.length };
      },
    },
  };
  return {
    prisma,
    Prisma: { PrismaClientKnownRequestError },
    runInTenantContext: async (_s: string, fn: () => unknown) => fn(),
  };
});
vi.mock('../../apps/api/src/lib/savepoint', () => ({
  withSavepoint: async (fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (e) {
      db.aborted = false; // ROLLBACK TO SAVEPOINT
      throw e;
    }
  },
}));
vi.mock('../../apps/api/src/services/plan-entitlements', () => ({
  getEntitlements: async () => (db.plan ? { planCode: db.plan } : null),
}));
vi.mock('../../apps/api/src/lib/webhook-http', () => ({ postWebhook: db.post }));
vi.mock('../../apps/api/src/services/encryption.service', () => ({
  encryption: {
    decrypt: (s: string) => {
      if (s === 'BROKEN') throw new Error('bad cipher');
      return `dec(${s})`;
    },
    encrypt: (s: string) => `enc(${s})`,
  },
}));

import {
  fanoutWebhookEvent,
  runDeliveryAttempt,
  createResend,
  createTestDelivery,
  delayBeforeAttempt,
  decideAfterAttempt,
  newWebhookSecret,
  webhookStoreEntitled,
  markDeliveryFailed,
} from '../../apps/api/src/services/webhook.service';

const ep = (o: Row = {}) => ({
  id: 'e1',
  storeId: 's1',
  url: 'https://h.example.com/x',
  secretEnc: 'sec',
  active: true,
  events: ['order.created'],
  includeCustomer: false,
  consecutiveFailures: 0,
  ...o,
});
const ev = {
  type: 'order.created',
  dedupeKey: 'order.created:o1',
  data: { order: { id: 'o1' } },
  customer: { name: 'A', email: 'a@x.co', phone: '1' },
};

beforeEach(() => {
  db.endpoints = [ep()];
  db.deliveries = [];
  db.ambient = 's1';
  db.aborted = false;
  db.plan = 'growth';
  db.post.mockReset();
});

describe('fan-out', () => {
  it('creates a delivery only for active endpoints subscribed to the type', async () => {
    db.endpoints = [
      ep(),
      ep({ id: 'e2', events: ['product.created'] }),
      ep({ id: 'e3', active: false }),
    ];
    const ids = await fanoutWebhookEvent('s1', ev);
    expect(ids).toHaveLength(1);
    expect(db.deliveries[0]).toMatchObject({
      endpointId: 'e1',
      storeId: 's1',
      eventType: 'order.created',
    });
  });
  it('is idempotent per (endpoint, dedupeKey): a replay creates nothing', async () => {
    await fanoutWebhookEvent('s1', ev);
    expect(await fanoutWebhookEvent('s1', ev)).toEqual([]);
    expect(db.deliveries).toHaveLength(1);
  });
  it('C1: a duplicate never aborts the transaction; an endpoint added between two identical events still gets its row', async () => {
    db.endpoints = [ep(), ep({ id: 'e2', events: ['order.created', 'order.paid'] })];
    const paid = { ...ev, type: 'order.paid', dedupeKey: 'order.paid:o1' };
    db.endpoints = [ep({ events: ['order.created', 'order.paid'] })];
    const a = await fanoutWebhookEvent('s1', ev);
    const a2 = await fanoutWebhookEvent('s1', paid);
    expect(a).toHaveLength(1);
    expect(a2).toHaveLength(1);
    // second endpoint appears, then the SAME two events are emitted again (stuck-sweep / delayed webhook)
    db.endpoints.push(ep({ id: 'e2', events: ['order.created', 'order.paid'] }));
    const b = await fanoutWebhookEvent('s1', ev);
    const b2 = await fanoutWebhookEvent('s1', paid);
    expect(b).toHaveLength(1);
    expect(b2).toHaveLength(1);
    expect(db.aborted).toBe(false);
    expect(db.deliveries.filter(d => d.endpointId === 'e2')).toHaveLength(2);
    expect(db.deliveries).toHaveLength(4);
  });
  it('C1: duplicates for the FIRST endpoint do not stop the SECOND endpoint in the same call', async () => {
    db.endpoints = [ep(), ep({ id: 'e2' })];
    await fanoutWebhookEvent('s1', ev);
    db.deliveries = db.deliveries.filter(d => d.endpointId === 'e1'); // e2 row lost / never made
    const ids = await fanoutWebhookEvent('s1', ev);
    expect(ids).toHaveLength(1);
    expect(db.deliveries.map(d => d.endpointId).sort()).toEqual(['e1', 'e2']);
  });
  it('minimal PII: customer only for endpoints that opted in', async () => {
    db.endpoints = [ep(), ep({ id: 'e2', includeCustomer: true })];
    await fanoutWebhookEvent('s1', ev);
    const by = (id: string) => db.deliveries.find(d => d.endpointId === id)!.payload.data;
    expect(by('e1').customer).toBeUndefined();
    expect(JSON.stringify(db.deliveries.find(d => d.endpointId === 'e1')!.payload)).not.toContain(
      'a@x.co'
    );
    expect(by('e2').customer).toEqual({ name: 'A', email: 'a@x.co', phone: '1' });
  });
  it('I2: the event id is derived from the stable source key: the same event gets the same id on every endpoint and every re-fan-out', async () => {
    db.endpoints = [ep(), ep({ id: 'e2' })];
    await fanoutWebhookEvent('s1', ev);
    const ids = db.deliveries.map(d => d.eventId);
    expect(new Set(ids).size).toBe(1);
    db.deliveries = [];
    await fanoutWebhookEvent('s1', ev);
    expect(db.deliveries.map(d => d.eventId)).toEqual([ids[0], ids[0]]);
    await fanoutWebhookEvent('s1', { ...ev, dedupeKey: 'order.created:o2' });
    expect(db.deliveries.at(-1)!.eventId).not.toBe(ids[0]);
    expect(ids[0]).toMatch(/^evt_[0-9a-f]{32}$/);
  });
  it('envelope is versioned with an evt_ id', async () => {
    await fanoutWebhookEvent('s1', ev);
    expect(db.deliveries[0].payload).toMatchObject({
      type: 'order.created',
      apiVersion: '2026-10-21',
      storeId: 's1',
    });
    expect(db.deliveries[0].payload.id).toMatch(/^evt_/);
    expect(db.deliveries[0].payload.id).toBe(db.deliveries[0].eventId);
  });
  it('keeps the last 50 deliveries per endpoint', async () => {
    for (let i = 0; i < 53; i++) await fanoutWebhookEvent('s1', { ...ev, dedupeKey: `k${i}` });
    expect(db.deliveries).toHaveLength(50);
  });
  it("tenant isolation: another store's endpoints are never read", async () => {
    db.endpoints = [ep({ storeId: 's2' })];
    expect(await fanoutWebhookEvent('s1', ev)).toEqual([]);
  });
  it('a query without the ambient storeId is refused (guard model)', async () => {
    db.ambient = 's2';
    await expect(fanoutWebhookEvent('s1', ev)).rejects.toThrow(/TenantScopeViolation/);
  });
});

describe('resend / test', () => {
  it('resend keeps the event id and bytes, new delivery id', async () => {
    const [id] = await fanoutWebhookEvent('s1', ev);
    const nid = await createResend('s1', id);
    const [a, b] = db.deliveries;
    expect(nid).not.toBe(id);
    expect(b.eventId).toBe(a.eventId);
    expect(b.payload).toEqual(a.payload);
    expect(b.dedupeKey).toBeNull();
  });
  it("resend of another store's delivery is null", async () => {
    const [id] = await fanoutWebhookEvent('s1', ev);
    db.deliveries[0].storeId = 's2';
    expect(await createResend('s1', id)).toBeNull();
  });
  it('test delivery is flagged and typed webhook.test', async () => {
    await createTestDelivery('s1', 'e1');
    expect(db.deliveries[0]).toMatchObject({ isTest: true, eventType: 'webhook.test' });
  });
});

describe('retry schedule', () => {
  it('6 bounded attempts, first immediate, then 1m 10m 1h 6h 17h', () => {
    expect([1, 2, 3, 4, 5, 6].map(delayBeforeAttempt)).toEqual([0, 60, 600, 3600, 21600, 61200]);
  });
  it('decides retry until attempt 6, then failed; test events never retry', () => {
    expect(decideAfterAttempt({ ok: false, attempt: 1, isTest: false })).toBe('retry');
    expect(decideAfterAttempt({ ok: false, attempt: 5, isTest: false })).toBe('retry');
    expect(decideAfterAttempt({ ok: false, attempt: 6, isTest: false })).toBe('failed');
    expect(decideAfterAttempt({ ok: false, attempt: 1, isTest: true })).toBe('failed');
    expect(decideAfterAttempt({ ok: true, attempt: 3, isTest: false })).toBe('success');
  });
});

describe('attempts and auto-disable', () => {
  const fail = { ok: false, status: 500, snippet: 'boom', error: 'http_500', durationMs: 5 };
  const okRes = { ok: true, status: 200, snippet: 'ok', error: null, durationMs: 5 };

  it('success marks delivered and resets the failure streak', async () => {
    db.endpoints = [ep({ consecutiveFailures: 4 })];
    const [id] = await fanoutWebhookEvent('s1', ev);
    db.post.mockResolvedValue(okRes);
    const r = await runDeliveryAttempt('s1', id, 1);
    expect(r.decision).toBe('success');
    expect(db.deliveries[0]).toMatchObject({ status: 'success', attempts: 1, responseStatus: 200 });
    expect(db.endpoints[0].consecutiveFailures).toBe(0);
    expect(db.post.mock.calls[0][0]).toMatchObject({
      secret: 'dec(sec)',
      eventId: db.deliveries[0].eventId,
    });
  });
  it('a failing attempt schedules a retry and does NOT count against the endpoint yet', async () => {
    const [id] = await fanoutWebhookEvent('s1', ev);
    db.post.mockResolvedValue(fail);
    const r = await runDeliveryAttempt('s1', id, 2);
    expect(r.decision).toBe('retry');
    expect(db.deliveries[0].status).toBe('retrying');
    expect(db.deliveries[0].nextAttemptAt).toBeInstanceOf(Date);
    expect(db.endpoints[0].consecutiveFailures).toBe(0);
  });
  it('the 6th failure marks failed and counts once; the 10th consecutive disables the endpoint', async () => {
    db.endpoints = [ep({ consecutiveFailures: 9 })];
    const [id] = await fanoutWebhookEvent('s1', ev);
    db.post.mockResolvedValue(fail);
    const r = await runDeliveryAttempt('s1', id, 6);
    expect(r).toMatchObject({ decision: 'failed', endpointDisabled: true });
    expect(db.deliveries[0].status).toBe('failed');
    expect(db.endpoints[0]).toMatchObject({
      active: false,
      disabledReason: 'consecutive_failures',
      consecutiveFailures: 10,
    });
  });
  it('the 9th does not disable', async () => {
    db.endpoints = [ep({ consecutiveFailures: 8 })];
    const [id] = await fanoutWebhookEvent('s1', ev);
    db.post.mockResolvedValue(fail);
    const r = await runDeliveryAttempt('s1', id, 6);
    expect(r.endpointDisabled).toBe(false);
    expect(db.endpoints[0].active).toBe(true);
  });
  it('a test event failing is final, never counts, never disables', async () => {
    db.endpoints = [ep({ consecutiveFailures: 9 })];
    const id = await createTestDelivery('s1', 'e1');
    db.post.mockResolvedValue(fail);
    const r = await runDeliveryAttempt('s1', id, 1);
    expect(r).toMatchObject({ decision: 'failed', endpointDisabled: false });
    expect(db.endpoints[0]).toMatchObject({ active: true, consecutiveFailures: 9 });
  });
  it('a queued delivery to a disabled endpoint is not sent', async () => {
    const [id] = await fanoutWebhookEvent('s1', ev);
    db.endpoints[0].active = false;
    const r = await runDeliveryAttempt('s1', id, 1);
    expect(r.decision).toBe('skipped');
    expect(db.post).not.toHaveBeenCalled();
    expect(db.deliveries[0]).toMatchObject({ status: 'failed', error: 'endpoint_disabled' });
  });
  it('I3: a delivery queued before a downgrade is not sent after it (and is marked failed, not retried)', async () => {
    const [id] = await fanoutWebhookEvent('s1', ev);
    db.plan = 'basic';
    const r = await runDeliveryAttempt('s1', id, 1);
    expect(r.decision).toBe('skipped');
    expect(db.post).not.toHaveBeenCalled();
    expect(db.deliveries[0]).toMatchObject({ status: 'failed', error: 'plan_lapsed' });
  });
  it('I3: entitlement is Growth/Business only and fails closed when unknown', async () => {
    for (const [plan, want] of [
      ['growth', true],
      ['business', true],
      ['basic', false],
      ['free', false],
      [null, false],
    ] as const) {
      db.plan = plan;
      expect(await webhookStoreEntitled('s1')).toBe(want);
    }
  });
  it('M7: an error inside the attempt (e.g. a secret that cannot be decrypted) is a failed attempt on the retry schedule, not a stuck row', async () => {
    db.endpoints = [ep({ secretEnc: 'BROKEN' })];
    const [id] = await fanoutWebhookEvent('s1', ev);
    const r = await runDeliveryAttempt('s1', id, 1);
    expect(r.decision).toBe('retry');
    expect(db.deliveries[0]).toMatchObject({ status: 'retrying', error: 'internal_error' });
    const r6 = await runDeliveryAttempt('s1', id, 6);
    expect(r6.decision).toBe('failed');
    expect(db.deliveries[0].status).toBe('failed');
    expect(db.post).not.toHaveBeenCalled();
  });
  it('M7: markDeliveryFailed (the onFailure backstop) fails a pending row and never touches a delivered one', async () => {
    const [id] = await fanoutWebhookEvent('s1', ev);
    await markDeliveryFailed('s1', id, 'run_failed');
    expect(db.deliveries[0]).toMatchObject({
      status: 'failed',
      error: 'run_failed',
      nextAttemptAt: null,
    });
    db.deliveries[0].status = 'success';
    await markDeliveryFailed('s1', id, 'run_failed');
    expect(db.deliveries[0].status).toBe('success');
  });
  it('an already-successful delivery is never re-sent (Inngest replay)', async () => {
    const [id] = await fanoutWebhookEvent('s1', ev);
    db.deliveries[0].status = 'success';
    expect((await runDeliveryAttempt('s1', id, 1)).decision).toBe('skipped');
    expect(db.post).not.toHaveBeenCalled();
  });
});

describe('secret', () => {
  it('is whsec_ prefixed, random, with a 4 char hint', () => {
    const a = newWebhookSecret();
    expect(a.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(a.hint).toBe(a.secret.slice(-4));
    expect(newWebhookSecret().secret).not.toBe(a.secret);
  });
});
