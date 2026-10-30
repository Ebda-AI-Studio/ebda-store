/**
 * Ruling CF-JOBS-4: the money jobs that serve a store on its Durable Object. Each job here is proved on the DO path:
 * it is not refused, it reads and writes the store ONLY through the DO (the Postgres `prisma` mock is never touched), and
 * what it records goes through the DO op. The double-fire (a job delivered twice runs once) is proved on real workerd in
 * apps/api/workers-do/jobs-money.test.ts; the DO ops themselves in packages/repo/test/do-job-ops.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const DO_STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';

const h = vi.hoisted(() => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, p) => {
        throw new Error(`Postgres touched: prisma.${String(p)}`);
      },
    }
  ),
  doDb: {
    order: { findMany: vi.fn() },
    payment: { findMany: vi.fn() },
    paymentEvent: { findMany: vi.fn() },
    storeWhatsAppLink: { findUnique: vi.fn() },
    storeWhatsAppConsent: { findMany: vi.fn() },
  } as Record<string, Record<string, ReturnType<typeof vi.fn>>>,
  money: {
    paymentEventRecord: vi.fn(async () => ({ recorded: true })),
    abandonStamp: vi.fn(async () => ({ stamped: true })),
    trialBalance: vi.fn(async () => ({ debit: 100, credit: 100 })),
    periodGlCredits: vi.fn(async () => ({ total: 50 })),
    journalSale: vi.fn(async () => ({ posted: true, entries: 2 })),
    journalRefund: vi.fn(async () => ({ reversed: 2 })),
  },
  send: vi.fn(async () => undefined),
  sendAlert: vi.fn(async () => 'sent'),
  sendStoreEvents: vi.fn(async () => undefined),
  handleWebhook: vi.fn(async () => ({ success: true, status: 'completed', orderId: 'o1' })),
  inbox: {
    get: vi.fn(),
    update: vi.fn(async () => undefined),
  },
}));

vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: h.prisma,
    extra: {
      currentStoreId: () => DO_STORE,
      storeDirectory: async () => [
        { id: DO_STORE, name: 'Demo', slug: 'demo', accountingEnabled: true },
      ],
      runInTenantContext: async () => {
        throw new Error('Postgres touched: runInTenantContext');
      },
      withStore: async () => {
        throw new Error('Postgres touched: withStore');
      },
    },
  })
);
vi.mock('@api/lib/repo-factory', () => ({
  storeRepo: async (storeId: string) => ({
    storeId,
    backend: 'do',
    db: h.doDb,
    money: h.money,
  }),
  storeMoney: async () => h.money,
  storeDb: async () => h.doDb,
  runInJobRepoScope: <T>(fn: () => T) => fn(),
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    send: h.send,
    createFunction: (options: unknown, handler: unknown) => ({ options, handler }),
  },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.sendAlert }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/definer', () => ({ webhookInbox: h.inbox }));
vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: { handleWebhook: h.handleWebhook },
}));
vi.mock('@api/lib/wa/events', () => ({
  buildStoreEvent: async (input: unknown) => input,
  sendStoreEvents: h.sendStoreEvents,
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => true },
}));
vi.mock('@api/services/sentry.service', () => ({ SentryService: { captureException: vi.fn() } }));
vi.mock('@api/lib/wa/plan-state', () => ({
  PLAN_CHANGED_EVENT: 'store/plan-changed',
  planChangedInput: async () => ({ input: { type: 'plan.changed' }, seed: 'plan:x' }),
}));
vi.mock('@api/services/redis.service', () => ({ redis: { exists: vi.fn(), set: vi.fn() } }));

import { MONEY_JOBS, PORTED_JOBS, PORTED_MONEY_JOBS } from '@api/lib/jobs/job-data';
import { decideRunForStore, doStoreIds } from '@api/lib/jobs/do-guard';
import { sweepStoresDb } from '@api/lib/jobs/store-db';
import { handleOrderCreatedStuckSweep } from '@api/lib/inngest/functions/order-created-stuck-sweep';
import { handlePaymentReconcileSweep } from '@api/lib/inngest/functions/payment-reconcile-sweep';
import { paymentWebhookProcess } from '@api/lib/inngest/functions/payment-webhook-process';
import { accountingPostOrderJournal } from '@api/lib/inngest/functions/accounting-post-order-journal';
import { accountingPostRefundJournal } from '@api/lib/inngest/functions/accounting-post-refund-journal';
import { accountingDailyClose } from '@api/lib/inngest/functions/accounting-daily-close';
import { emitStoreEventsFor, waPlanSync } from '@api/lib/inngest/functions/wa-store-events';

const alarm = { data: { alarm: true, storeId: DO_STORE } };
const step = {
  run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => {
    const v = await fn();
    return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const m of Object.values(h.doDb)) for (const f of Object.values(m)) f.mockReset();
  vi.stubEnv('JOBS_ON_DO', '1');
  vi.stubEnv('STORE_DO_ENABLED_IDS', DO_STORE);
});

describe('the ported money jobs are not refused for a DO store; the unported ones still are', () => {
  it('every ported job runs; every job still in MONEY_JOBS is refused with a P0 class', () => {
    expect(doStoreIds().has(DO_STORE)).toBe(true);
    for (const id of [...PORTED_MONEY_JOBS, 'wa-store-events', ...PORTED_JOBS])
      expect(decideRunForStore({ id } as never, DO_STORE), id).toEqual({ run: true });
    for (const id of MONEY_JOBS)
      expect(decideRunForStore({ id } as never, DO_STORE), id).toMatchObject({
        run: false,
        money: true,
      });
  });
});

describe('sweepStoresDb', () => {
  it('a DO store alarm reads the store through its Durable Object and never opens Postgres', async () => {
    h.doDb.order.findMany.mockResolvedValue([
      { id: 'b', n: 2 },
      { id: 'a', n: 1 },
    ]);
    const rows = await sweepStoresDb(alarm, {
      fetch: (storeId, db) => db.order.findMany({ where: { storeId } } as never) as never,
      orderKey: (r: { n: number }) => r.n,
      take: 1,
    });
    expect(rows).toEqual([{ id: 'a', n: 1 }]);
    expect(h.doDb.order.findMany).toHaveBeenCalledWith({ where: { storeId: DO_STORE } });
  });
});

describe('order-created-stuck-sweep on a DO store', () => {
  it('finds the paid-but-unnotified order in the DO and re-sends order/created', async () => {
    h.doDb.order.findMany.mockResolvedValue([
      { id: 'o1', storeId: DO_STORE, locale: 'ar', createdAt: new Date(Date.now() - 20 * 60_000) },
    ]);
    const r = await handleOrderCreatedStuckSweep(step, alarm);
    expect(r.resent).toBe(1);
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'order/created',
        data: expect.objectContaining({ storeId: DO_STORE }),
      })
    );
  });
});

describe('payment-reconcile-sweep on a DO store', () => {
  it('alerts once and records the reconciliation row through the DO op', async () => {
    h.doDb.payment.findMany.mockResolvedValue([
      {
        id: 'p1',
        orderId: 'o1',
        provider: 'paymob',
        amount: 5000,
        currency: 'EGP',
        order: { storeId: DO_STORE },
      },
    ]);
    h.doDb.paymentEvent.findMany.mockResolvedValue([]);
    const r = await handlePaymentReconcileSweep(step, alarm);
    expect(r).toEqual({ scanned: 1, alerted: 1 });
    expect(h.money.paymentEventRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: 'p1',
        orderId: 'o1',
        eventType: 'reconciliation',
        details: { reason: 'completed_payment_on_cancelled_order' },
      })
    );
  });
  it('does not alert again once the marker row exists (alert-once)', async () => {
    h.doDb.payment.findMany.mockResolvedValue([
      {
        id: 'p1',
        orderId: 'o1',
        provider: 'paymob',
        amount: 1,
        currency: 'EGP',
        order: { storeId: DO_STORE },
      },
    ]);
    h.doDb.paymentEvent.findMany.mockResolvedValue([
      { details: { reason: 'completed_payment_on_cancelled_order' } },
    ]);
    const r = await handlePaymentReconcileSweep(step, alarm);
    expect(r.alerted).toBe(0);
    expect(h.money.paymentEventRecord).not.toHaveBeenCalled();
  });
});

describe('payment-webhook-process on a DO store (C1)', () => {
  const row = (status: string) => ({
    id: 'wh1',
    status,
    provider: 'paymob',
    payload: { a: 1 },
    signature: 'sig',
    rawBody: '{"a":1}',
    storeId: DO_STORE,
    idempotencyKey: 'k1',
  });
  const run = () =>
    (
      paymentWebhookProcess as unknown as {
        handler: (a: unknown) => Promise<unknown>;
      }
    ).handler({
      event: { name: 'payment/webhook.received', data: { webhookEventId: 'wh1' } },
      step,
    });

  it('applies the delivery through PaymentService (the DO paymentWebhook) and never reads or stamps Postgres', async () => {
    h.inbox.get.mockResolvedValue(row('received'));
    await run(); // the prisma / runInTenantContext mocks THROW if Postgres is reached
    expect(h.handleWebhook).toHaveBeenCalledWith('paymob', { a: 1 }, 'sig', DO_STORE, '{"a":1}');
    expect(h.inbox.update).toHaveBeenCalledWith(
      'wh1',
      expect.objectContaining({ status: 'processed' })
    );
  });

  it('a second delivery of the same inbox row (already processed) applies nothing: it runs once', async () => {
    h.inbox.get.mockResolvedValue(row('received'));
    await run();
    h.inbox.get.mockResolvedValue(row('processed'));
    await run();
    expect(h.handleWebhook).toHaveBeenCalledTimes(1);
  });

  it('an external fact the DO records but cannot apply is not turned into a failure of the job', async () => {
    h.inbox.get.mockResolvedValue(row('received'));
    h.handleWebhook.mockResolvedValueOnce({ success: true, orderId: undefined } as never);
    await expect(run()).resolves.toBeUndefined();
    expect(h.inbox.update).toHaveBeenCalledWith(
      'wh1',
      expect.objectContaining({ status: 'processed' })
    );
  });
});

type Handler = { handler: (a: unknown) => Promise<unknown> };
describe('accounting jobs on a DO store', () => {
  it('order/created posts the sale through the DO journalSale, with no Postgres transaction', async () => {
    await (accountingPostOrderJournal as unknown as Handler).handler({
      event: { name: 'order/created', data: { orderId: 'o1', storeId: DO_STORE } },
      step,
    });
    expect(h.money.journalSale).toHaveBeenCalledWith({ orderId: 'o1' });
  });
  it('order/refunded reverses through the DO journalRefund', async () => {
    await (accountingPostRefundJournal as unknown as Handler).handler({
      event: { name: 'order/refunded', data: { orderId: 'o1', storeId: DO_STORE } },
      step,
    });
    expect(h.money.journalRefund).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'o1' }));
  });
  it('the daily close reads the DO trial balance and alerts P0 only on drift', async () => {
    const run = () => (accountingDailyClose as unknown as Handler).handler({ event: alarm, step });
    expect(await run()).toEqual({ stores: 1, drifts: 0 });
    h.money.trialBalance.mockResolvedValueOnce({ debit: 120, credit: 100 });
    expect(await run()).toEqual({ stores: 1, drifts: 1 });
    expect(h.sendAlert).toHaveBeenCalledWith(expect.objectContaining({ level: 'p0' }));
  });
});

describe('wa-store-events: the erasure step runs for a DO store', () => {
  it('account/erased reads the link row from the DO and sends customer.erased', async () => {
    h.doDb.storeWhatsAppLink.findUnique.mockResolvedValue({ storeId: DO_STORE });
    const n = await emitStoreEventsFor({
      name: 'account/erased',
      data: { storeId: DO_STORE, buyerKey: 'bk1' },
    });
    expect(n).toBe(1);
    expect(h.sendStoreEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'customer.erased',
        storeId: DO_STORE,
        data: { buyerKey: 'bk1' },
      }),
    ]);
  });
  it('a store with no link row sends nothing', async () => {
    h.doDb.storeWhatsAppLink.findUnique.mockResolvedValue(null);
    expect(
      await emitStoreEventsFor({
        name: 'account/erased',
        data: { storeId: DO_STORE, buyerKey: 'bk1' },
      })
    ).toBe(0);
    expect(h.sendStoreEvents).not.toHaveBeenCalled();
  });
});

describe('wa-plan-sync on a DO store', () => {
  it('its alarm finds the linked DO store and sends the plan state, with no Postgres', async () => {
    h.doDb.storeWhatsAppLink.findUnique.mockResolvedValue({ storeId: DO_STORE });
    h.doDb.storeWhatsAppConsent.findMany.mockResolvedValue([]);
    const r = (await (waPlanSync as unknown as Handler).handler({ event: alarm, step })) as {
      sent: number;
    };
    expect(r.sent).toBe(1);
    expect(h.sendStoreEvents).toHaveBeenCalledTimes(1);
  });
  it('a store with no link row is idle', async () => {
    h.doDb.storeWhatsAppLink.findUnique.mockResolvedValue(null);
    expect(await (waPlanSync as unknown as Handler).handler({ event: alarm, step })).toEqual({
      sent: 0,
    });
  });
});

describe('the ported jobs reach their store only through the DO-aware clients', () => {
  const read = (f: string) => readFileSync(`apps/api/src/lib/inngest/functions/${f}`, 'utf8');
  it('sweeps list stores with sweepStoresDb / acrossStoresDb, not the raw cross-store helpers', () => {
    for (const f of [
      'order-created-stuck-sweep.ts',
      'payment-reconcile-sweep.ts',
      'payment-abandonment-sweep.ts',
      'refund-reversal-stuck-sweep.ts',
      'refund-claim-stuck-sweep.ts',
      'order-auto-cancel-unpaid.ts',
      'instapay-expiry.ts',
    ]) {
      const src = read(f);
      expect(src, f).not.toMatch(
        /import[^;]*\b(sweepAcrossStores|acrossStoresFlat|acrossStores)\b[^;]*;/
      );
      expect(src, f).toMatch(/sweepStoresDb|acrossStoresDb/);
    }
  });
});
