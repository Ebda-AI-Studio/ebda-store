/**
 * Ruling CF-JOBS-4, review finding C1 end to end: a payment webhook for a store on its Durable Object, from the queue message
 * the webhook route sends (`payment/webhook.received`) through the REAL jobs runner (JOBS_ON_DO=1), the REAL job, the REAL
 * `PaymentService.handleWebhook` (provider config read from the DO), into the DO's money engine (real DO schema on SQLite).
 * The order must end PAID in the DO, the inbox row `processed`, the job must not be refused, and a second delivery of the same
 * message must apply nothing. `@ebda/database`'s `prisma` THROWS on any use: any slip to Postgres fails the test.
 * (The route half - signature check and inbox write - is covered by the webhook route tests.)
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const h = vi.hoisted(() => ({
  inbox: new Map<string, Record<string, unknown>>(),
  sendAlert: vi.fn(async () => 'sent'),
  send: vi.fn(async () => undefined),
  stub: {} as Record<string, unknown>,
}));

vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  const boom = (what: string) => () => {
    throw new Error(`Postgres touched: ${what}`);
  };
  return {
    ...real,
    prisma: new Proxy({}, { get: (_t, p) => boom(`prisma.${String(p)}`)() }),
    runInTenantContext: boom('runInTenantContext'),
    withStore: boom('withStore'),
  };
});
vi.mock('@api/lib/store-backend', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/store-backend')>()),
  backendFor: async () => 'do',
  storeDo: () => h.stub,
}));
vi.mock('@api/lib/definer', () => ({
  webhookInbox: {
    get: async (id: string) => h.inbox.get(id) ?? null,
    update: async (id: string, patch: Record<string, unknown>) => {
      const row = h.inbox.get(id)!;
      if (patch.status) row.status = patch.status;
      if (patch.incrementAttempts) row.attempts = ((row.attempts as number) ?? 0) + 1;
      if (patch.markProcessed) Object.assign(row, patch.markProcessed);
    },
  },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.sendAlert }));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    send: h.send,
    createFunction: (o: unknown, f: unknown) => ({ options: o, handler: f }),
  },
}));
// the per-row concurrency lease is a Durable Object of its own (proved on workerd in workers-test/jobs.test.ts): a free lease here
vi.mock('@api/lib/jobs/gate', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/jobs/gate')>()),
  gateClient: {
    acquire: async () => 'tok',
    renew: async () => true,
    release: async () => undefined,
  },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@sentry/cloudflare', () => ({
  captureException: vi.fn(),
  flush: vi.fn(async () => true),
}));
vi.mock('@api/services/redis.service', () => ({
  redis: { get: async () => null, set: async () => undefined, del: async () => undefined },
}));

import {
  answerMoneyOp,
  answerStockOp,
  createPrismaLite,
  decodeRpc,
  encodeRpc,
  ensureIdempotencySchema,
  ensureMoneyOpsSchema,
  ensurePaymentSchema,
  runReads,
  runWrites,
} from '@ebda-src/repo';
import { encryption } from '@api/services/encryption.service';
import { PaymentService } from '@api/services/payment-providers/payment.factory';
import { registerProviderV2 } from '@api/services/payment-providers/registry';
import {
  PaymentProviderError,
  type PaymentProviderV2,
} from '@api/services/payment-providers/types';
import { PAYMOB_HMAC_HEADER } from '@api/services/payment-providers/paymob.provider';
import { clearJobRegistry, registerJob } from '@api/lib/jobs/registry';
import { handleJobsBatch, type QueueMessageLike } from '@api/lib/jobs/run-queue';
import { paymentWebhookProcess } from '@api/lib/inngest/functions/payment-webhook-process';
import { META, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';

const sqlite = openSqlite();
let orderId = '';
let total = 0;

const stubProvider: PaymentProviderV2 = {
  name: 'paymob',
  capabilities: {
    methods: ['card'],
    instructions: ['redirect'],
    currencies: ['EGP'],
    partialRefunds: true,
    refunds: true,
    webhooks: true,
    remoteStatus: false,
    savedCards: false,
  },
  async createPayment() {
    throw new Error('not used');
  },
  verifyWebhook(rawBody, headers) {
    if (headers[PAYMOB_HMAC_HEADER] !== 'good')
      throw new PaymentProviderError('WEBHOOK_BAD_SIGNATURE', 'bad signature');
    const b = JSON.parse(String(rawBody));
    return {
      kind: 'payment',
      eventId: b.eventId,
      providerRef: b.providerRef,
      status: b.status,
      amountMinor: b.amountMinor,
      currency: 'EGP',
      rawPayload: b,
    };
  },
  async getStatus() {
    throw new Error('not used');
  },
  async refund() {
    throw new Error('not used');
  },
  async partialRefund() {
    throw new Error('not used');
  },
};

beforeAll(async () => {
  process.env.JOBS_ON_DO = '1';
  process.env.STORE_DO_ENABLED_IDS = STORE;
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const sync = nodeSyncSql(sqlite);
  ensureMoneyOpsSchema(sync);
  ensurePaymentSchema(sync);
  sqlite.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status, cost_price) VALUES ('p1', '${STORE}', 'Tee', 'tee', 1000, 20, 'active', 400);
     INSERT OR REPLACE INTO store_config (store_id, accounting_enabled) VALUES ('${STORE}', 0);`
  );
  sqlite
    .prepare(
      `INSERT INTO payment_configs (id, store_id, provider, is_enabled, is_default, api_key, webhook_secret, settings) VALUES ('cfg1', ?, 'paymob', 1, 1, ?, ?, '{}')`
    )
    .run(STORE, encryption.encrypt('stub-key'), encryption.encrypt('stub-secret'));
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId: STORE }) as never;
  h.stub = {
    moneyOp: async (s: string, op: string, argsJson: string, key?: string) =>
      answerMoneyOp(sync, s, op, argsJson, key),
    stockOp: async (s: string, op: string, argsJson: string, key?: string) =>
      answerStockOp(sync, s, op, argsJson, key),
    query: async (_s: string, q: never) => runReads(lite, q),
    mutate: async (_s: string, m: never) => runWrites(lite, sql, m),
  };
  const money = (op: string, args: object) => {
    const r = answerMoneyOp(sync, STORE, op, encodeRpc(args));
    if (!r.ok) throw new Error(`${op}: ${r.code}`);
    return decodeRpc<any>(r.json);
  };
  const o = money('createOrder', {
    lines: [{ productId: 'p1', quantity: 3 }],
    shippingAddress: { phone: '01000000001' },
  });
  orderId = o.orderId;
  total = o.total;
  money('paymentCreate', { orderId, provider: 'paymob', amount: total, transactionId: 'tx-e2e' });
  registerProviderV2(stubProvider);
});

beforeEach(() => {
  clearJobRegistry();
  registerJob(paymentWebhookProcess.options, paymentWebhookProcess.handler);
  PaymentService.clearCache();
  h.sendAlert.mockClear();
  h.send.mockClear();
});

const body = () =>
  JSON.stringify({
    eventId: 'ev-e2e-1',
    providerRef: 'tx-e2e',
    status: 'completed',
    amountMinor: total,
  });
const deliver = async () => {
  const m = {
    id: 'm1',
    attempts: 1,
    body: {
      kind: 'job',
      fn: 'payment-webhook-process',
      event: {
        name: 'payment/webhook.received',
        id: 'e1',
        data: { webhookEventId: 'wh-1', provider: 'paymob', idempotencyKey: 'k1', storeId: STORE },
      },
    },
    ack: vi.fn(),
    retry: vi.fn(),
  };
  await handleJobsBatch({ queue: 'ebda-jobs', messages: [m as QueueMessageLike] });
  return m;
};
const row = (sql: string) => sqlite.prepare(sql).get() as Record<string, any>;

describe('payment webhook for a DO store, queue to DO', () => {
  it('applies the payment in the DO, marks the inbox row processed, raises no refusal, and a second delivery changes nothing', async () => {
    h.inbox.set('wh-1', {
      id: 'wh-1',
      provider: 'paymob',
      idempotencyKey: 'k1',
      storeId: STORE,
      status: 'received',
      attempts: 0,
      signature: 'good',
      payload: JSON.parse(body()),
      rawBody: body(),
    });
    const m1 = await deliver();
    expect(m1.ack).toHaveBeenCalled();
    expect(m1.retry).not.toHaveBeenCalled();
    expect(h.sendAlert).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'jobs-do-guard' })
    );
    expect(row(`SELECT payment_status, status FROM orders WHERE id = '${orderId}'`)).toMatchObject({
      payment_status: 'paid',
    });
    expect(row(`SELECT status FROM payments WHERE order_id = '${orderId}'`).status).toBe(
      'completed'
    );
    expect(h.inbox.get('wh-1')!.status).toBe('processed');
    const events = row('SELECT count(*) n FROM payment_event_log').n;

    // the same message again (an at-least-once queue): the inbox row is processed, nothing is applied twice
    await deliver();
    expect(row('SELECT count(*) n FROM payment_event_log').n).toBe(events);
    expect(row(`SELECT count(*) n FROM payment_events WHERE event_type = 'webhook'`).n).toBe(1);
  });
});
