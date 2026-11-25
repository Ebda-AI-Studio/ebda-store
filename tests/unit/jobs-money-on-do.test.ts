/**
 * Ruling CF-JOBS-4: the money jobs that serve a store on its Durable Object. Each job here is proved on the DO path:
 * it is not refused, it reads and writes the store ONLY through the DO (the Postgres `prisma` mock is never touched), and
 * what it records goes through the DO op. The double-fire (a job delivered twice runs once) is proved on real workerd in
 * apps/api/workers-do/jobs-money.test.ts; the DO ops themselves in packages/repo/test/do-job-ops.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@api/lib/store-operational', () => ({
  STORE_NOT_OPERATIONAL: 'STORE_NOT_OPERATIONAL',
  isStoreOperational: (s: unknown) => s === 'active',
  storeOperational: async () => true,
  storeMayMessageCustomers: async () => true,
  assertStoreOperational: async () => undefined,
  activeStoreIds: async () => ({ has: () => true }) as unknown as Set<string>,
  requireOperationalStore: (_q: unknown, _r: unknown, next: () => void) => next(),
}));
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
    order: { findMany: vi.fn(), findUnique: vi.fn() },
    payment: { findMany: vi.fn() },
    paymentEvent: { findMany: vi.fn() },
    // the sale posting looks for pre-sale refunds to replay (replayPreSaleRefunds): none here
    journalEntry: { findFirst: vi.fn() },
    orderEvent: { findMany: vi.fn() },
    storeWhatsAppLink: { findUnique: vi.fn() },
    storeWhatsAppConsent: { findMany: vi.fn() },
    warehouse: { findFirst: vi.fn() },
  } as Record<string, Record<string, ReturnType<typeof vi.fn>>>,
  money: {
    paymentEventRecord: vi.fn(async () => ({ recorded: true })),
    abandonStamp: vi.fn(async () => ({ stamped: true })),
    trialBalance: vi.fn(async () => ({ debit: 100, credit: 100 })),
    periodGlCredits: vi.fn(async () => ({ total: 50 })),
    journalSale: vi.fn(async () => ({ posted: true, entries: 2 })),
    journalRepairSales: vi.fn(
      async (): Promise<{
        repaired: Array<{ orderId: string; orderNumber: string; entries: number }>;
        failed: Array<{ orderId: string; orderNumber: string; error: string }>;
      }> => ({ repaired: [], failed: [] })
    ),
    journalStaleCount: vi.fn(async () => ({ missing: 0, countedAt: Date.now() })),
    journalRefund: vi.fn(async () => ({ reversed: 2 })),
    orderNotifyClaim: vi.fn(async () => ({ claimed: true })),
    statusFanoutClaim: vi.fn(async () => ({ claimed: true })),
    statusFanoutComplete: vi.fn(async () => ({ completed: true })),
    cancel: vi.fn(async () => ({ replayed: true })),
    fiscalRefund: vi.fn(async () => ({ document: { number: 'CN-1' } })),
    fiscalCancelSale: vi.fn(async () => ({ document: null })),
    markerClaim: vi.fn(async () => ({ claimed: true })),
    markerRelease: vi.fn(async () => ({ released: 1 })),
    refundNotifyClaim: vi.fn(async () => ({ channels: ['email', 'dispatch', 'push'] })),
    refundNotifyRelease: vi.fn(async () => ({ released: ['email'] })),
    reversalClaim: vi.fn(async () => ({ claimed: true })),
    affiliateReverse: vi.fn(async () => ({ amount: null })),
    journalExpense: vi.fn(async () => ({ posted: true })),
    journalStockAdjustment: vi.fn(async () => ({ posted: true })),
    journalPoReceive: vi.fn(async () => ({ posted: true, entries: 1 })),
  },
  stock: {
    reconcileWarehouseAll: vi.fn(async () => ({
      skusReconciled: 3,
      skusFailed: 0,
      more: false,
      nextKey: null,
    })),
    reconcileWarehouseSku: vi.fn(async () => ({ reconciled: true, diff: 0 })),
  },
  reconcileSku: vi.fn(async () => ({ reconciled: false, diff: 0 })),
  sendConfirmation: vi.fn(async () => undefined),
  sendShipped: vi.fn(async () => undefined),
  sendRefunded: vi.fn(async () => undefined),
  createShipment: vi.fn(async () => ({ id: 'sh1', status: 'created' })),
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
      // `Store` / `User` are platform rows, still read from Postgres: only those two models may be asked of withStore
      withStore: async (_s: string, fn: (tx: unknown) => unknown) =>
        fn({
          store: { findUnique: async () => ({ name: 'Demo', settings: {} }) },
          user: { findFirst: async () => null },
        }),
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
  storeStock: async () => h.stock,
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
vi.mock('@api/services/shipping-carrier.service', () => ({
  shippingCarrierService: { createShipmentForOrder: h.createShipment },
}));
vi.mock('@api/services/onesignal.service', () => ({
  OneSignalService: {
    notifyAdminsOfShipmentFailure: vi.fn(),
    notifyAdminsOfOrder: vi.fn(async () => undefined),
    notifyOrdersAppOfOrder: vi.fn(async () => undefined),
    notifyAdminsOfRefund: vi.fn(async () => undefined),
  },
}));
vi.mock('@api/services/email.service', () => ({
  EmailService: {
    sendOrderConfirmation: h.sendConfirmation,
    sendOrderShipped: h.sendShipped,
    sendOrderRefunded: h.sendRefunded,
    sendOrderCancelledNotCharged: vi.fn(async () => undefined),
  },
}));
vi.mock('@api/services/notification-dispatcher.service', () => ({
  notificationDispatcher: { dispatch: vi.fn(async () => undefined) },
}));
vi.mock('@api/services/affiliate.service', () => ({
  affiliateService: { reverseCommission: vi.fn(async () => null), processCommission: vi.fn() },
}));
vi.mock('@api/services/warehouse.service', () => ({
  WarehouseService: {
    reconcileWarehouseStockToAggregate: h.reconcileSku,
    // the real service pages the DO op; this stand-in does the same single call so the sweep test stays about the job
    backfillReconcileAll: async () => {
      const r = await h.stock.reconcileWarehouseAll({ limit: 500, afterKey: null });
      return { skusReconciled: r.skusReconciled, skusFailed: r.skusFailed };
    },
  },
}));
vi.mock('@api/lib/public-cache', () => ({
  invalidateStoreProductCaches: vi.fn(async () => undefined),
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
import { accountingPostExpenseJournal } from '@api/lib/inngest/functions/accounting-post-expense-journal';
import { accountingPostPoReceiveJournal } from '@api/lib/inngest/functions/accounting-post-po-receive-journal';
import { accountingPostStockAdjustmentJournal } from '@api/lib/inngest/functions/accounting-post-stock-adjustment-journal';
import { handleOrderStatusChanged } from '@api/lib/inngest/functions/order-status-changed';
import { handleOrderRefunded } from '@api/lib/inngest/functions/order-refunded';
import { orderCreated } from '@api/lib/inngest/functions/order-created';
import { bookShipment } from '@api/lib/inngest/functions/shipment-create';
import { accountingDailyClose } from '@api/lib/inngest/functions/accounting-daily-close';
import { sweepAllWarehouseStores } from '@api/lib/inngest/functions/warehouse-reconcile-sweep';
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
  it('every ported job runs; every job still in MONEY_JOBS is refused with a P0 class', async () => {
    expect((await doStoreIds()).has(DO_STORE)).toBe(true);
    for (const id of [...PORTED_MONEY_JOBS, 'wa-store-events', ...PORTED_JOBS])
      expect(await decideRunForStore({ id } as never, DO_STORE), id).toEqual({ run: true });
    for (const id of MONEY_JOBS)
      expect(await decideRunForStore({ id } as never, DO_STORE), id).toMatchObject({
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

describe('order-created-stuck-sweep: journal reconcile (Ruling JOURNAL-RECONCILE-1)', () => {
  it('a DO store tick posts the missing sale entries over paid 10 min .. 72 h ago and reports the repair (info)', async () => {
    h.doDb.order.findMany.mockResolvedValue([]);
    h.money.journalRepairSales.mockResolvedValueOnce({
      repaired: [{ orderId: 'o1', orderNumber: 'ORD-1', entries: 2 }],
      failed: [],
    });
    const before = Date.now();
    const r = await handleOrderCreatedStuckSweep(step, alarm);
    expect(r.journalsRepaired).toBe(1);
    const arg = h.money.journalRepairSales.mock.calls[0]![0] as unknown as {
      paidAfterMs: number;
      paidBeforeMs: number;
    };
    expect(arg.paidBeforeMs).toBeLessThanOrEqual(before - 10 * 60_000 + 5_000);
    expect(arg.paidBeforeMs - arg.paidAfterMs).toBe(72 * 3_600_000 - 10 * 60_000);
    expect(h.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        source: 'journal.reconcile.repaired',
        store: expect.objectContaining({ id: DO_STORE }),
      })
    );
  });
  it('an order that cannot be posted pages P1', async () => {
    h.doDb.order.findMany.mockResolvedValue([]);
    h.money.journalRepairSales.mockResolvedValueOnce({
      repaired: [],
      failed: [{ orderId: 'o2', orderNumber: 'ORD-2', error: 'ACCOUNT_NOT_FOUND' }],
    });
    await handleOrderCreatedStuckSweep(step, alarm);
    expect(h.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'p1', source: 'journal.reconcile.failed' })
    );
  });
  it('paid orders past the window with no entry page P1 journal.reconcile.stale once a day (keyed per UTC day)', async () => {
    h.doDb.order.findMany.mockResolvedValue([]);
    h.money.journalStaleCount.mockResolvedValueOnce({ missing: 3, countedAt: Date.now() });
    await handleOrderCreatedStuckSweep(step, alarm);
    const day = new Date().toISOString().slice(0, 10);
    expect(h.money.journalStaleCount).toHaveBeenCalledWith(
      { day, maxAgeHours: 72 },
      `journal-stale:${day}`
    );
    expect(h.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'p1',
        source: 'journal.reconcile.stale',
        context: expect.objectContaining({ count: 3 }),
      })
    );
    // a later tick the same day gets the keyed replay (old countedAt): no second page
    h.sendAlert.mockClear();
    h.money.journalStaleCount.mockResolvedValueOnce({
      missing: 3,
      countedAt: Date.now() - 60 * 60_000,
    });
    await handleOrderCreatedStuckSweep(step, alarm);
    expect(h.sendAlert).not.toHaveBeenCalled();
  });
  it('nothing missing: no alert; the platform cron tick (no store) never calls the DO', async () => {
    h.doDb.order.findMany.mockResolvedValue([]);
    await handleOrderCreatedStuckSweep(step, alarm);
    expect(h.money.journalRepairSales).toHaveBeenCalledTimes(1);
    expect(h.sendAlert).not.toHaveBeenCalled();
    h.money.journalRepairSales.mockClear();
    await handleOrderCreatedStuckSweep(step, { data: {} }).catch(() => undefined);
    expect(h.money.journalRepairSales).not.toHaveBeenCalled();
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
  it('the expense, PO-receive and stock-adjustment journals post through the DO ops', async () => {
    const run = (job: unknown, name: string, data: Record<string, unknown>) =>
      (job as Handler).handler({ event: { name, data: { storeId: DO_STORE, ...data } }, step });
    await run(accountingPostExpenseJournal, 'accounting/expense-posted', { expenseId: 'e1' });
    await run(accountingPostPoReceiveJournal, 'stock/po-received', {
      poId: 'po1',
      clearedBackorders: [],
    });
    await run(accountingPostStockAdjustmentJournal, 'stock/adjustment-posted', {
      adjustmentId: 'a1',
    });
    expect(h.money.journalExpense).toHaveBeenCalledWith({ expenseId: 'e1' });
    expect(h.money.journalPoReceive).toHaveBeenCalledWith({ poId: 'po1', clearedBackorders: [] });
    expect(h.money.journalStockAdjustment).toHaveBeenCalledWith({ adjustmentId: 'a1' });
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

describe('order-created-fanout on a DO store', () => {
  const orderRow = {
    id: 'o1',
    orderNumber: '1001',
    customerId: null,
    locale: 'ar',
    paymentStatus: 'unpaid',
    currency: 'EGP',
    total: 1000,
    subtotal: 1000,
    shippingAddress: { firstName: 'A', lastName: 'B', email: 'a@example.test', phone: '0100' },
    items: [],
    appliedPromotion: null,
  };
  const fire = () =>
    (orderCreated as unknown as Handler).handler({
      event: {
        name: 'order/created',
        data: { orderId: 'o1', storeId: DO_STORE, paymentMethod: 'cod' },
      },
      step,
    });
  it('claims in the DO and sends the confirmation once; a second delivery sends nothing (double-fire)', async () => {
    h.doDb.order.findUnique.mockResolvedValue(orderRow);
    h.money.orderNotifyClaim.mockResolvedValueOnce({ claimed: true });
    await fire();
    expect(h.sendConfirmation).toHaveBeenCalledTimes(1);
    h.money.orderNotifyClaim.mockResolvedValueOnce({ claimed: false });
    await fire();
    expect(h.sendConfirmation).toHaveBeenCalledTimes(1);
  });
});

describe('order-status-changed-fanout on a DO store', () => {
  const row = {
    id: 'o1',
    orderNumber: '1001',
    customerId: null,
    locale: 'ar',
    total: 1000,
    currency: 'EGP',
    shippingAddress: { firstName: 'A', lastName: 'B', phone: '0100' },
    items: [],
  };
  it('claims and completes the transition in the DO, sends the shipped mail once; a second delivery does nothing', async () => {
    h.doDb.order.findUnique.mockResolvedValue(row);
    h.money.statusFanoutClaim.mockResolvedValueOnce({ claimed: true });
    await handleOrderStatusChanged('o1', DO_STORE, 'shipped', false, step);
    expect(h.sendShipped).toHaveBeenCalledTimes(1);
    expect(h.money.statusFanoutComplete).toHaveBeenCalledWith({ orderId: 'o1', status: 'shipped' });
    h.money.statusFanoutClaim.mockResolvedValueOnce({ claimed: false });
    const r = await handleOrderStatusChanged('o1', DO_STORE, 'shipped', false, step);
    expect(r).toMatchObject({ skipped: 'already-claimed' });
    expect(h.sendShipped).toHaveBeenCalledTimes(1);
  });
});

describe('order-refunded-fanout on a DO store', () => {
  const row = {
    id: 'o1',
    orderNumber: '1001',
    customerId: null,
    status: 'refunded',
    paymentStatus: 'refunded',
    locale: 'ar',
    total: 1000,
    currency: 'EGP',
    couponCode: null,
    walletAmount: 0,
    createdAt: new Date(),
    shippingAddress: { firstName: 'A', lastName: 'B', phone: '0100', email: 'a@example.test' },
    items: [{ productId: 'p1', variantId: null }],
    payments: [{ provider: 'paymob', status: 'refunded', refundedAmount: 1000, metadata: {} }],
  };
  it('does the fiscal credit, notifies once through the DO claim, reconciles the warehouse and stamps completion - and touches no stock itself', async () => {
    h.doDb.order.findUnique.mockResolvedValue(row);
    await handleOrderRefunded('o1', DO_STORE, true, true, step);
    expect(h.money.fiscalRefund).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'o1', refundRef: 'order:o1:full', amount: 'remaining' })
    );
    expect(h.money.refundNotifyClaim).toHaveBeenCalledWith({ orderId: 'o1' });
    expect(h.sendRefunded).toHaveBeenCalledTimes(1);
    expect(h.reconcileSku).toHaveBeenCalledWith(DO_STORE, 'p1', null);
    expect(h.money.reversalClaim).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'o1' }));
  });
  it('a second delivery: the DO claim hands out no channel, so nothing is sent twice', async () => {
    h.doDb.order.findUnique.mockResolvedValue(row);
    h.money.refundNotifyClaim.mockResolvedValueOnce({ channels: [] });
    await handleOrderRefunded('o1', DO_STORE, true, true, step);
    expect(h.sendRefunded).not.toHaveBeenCalled();
  });
  it('a cancelled order whose reversal never finished is finished by the idempotent DO cancel', async () => {
    h.doDb.order.findUnique.mockResolvedValue({
      ...row,
      status: 'cancelled',
      paymentStatus: 'unpaid',
      payments: [],
    });
    await handleOrderRefunded('o1', DO_STORE, true, false, step);
    expect(h.money.cancel).toHaveBeenCalledWith({ orderId: 'o1', restoreInventory: true });
  });
});

describe('shipment-create on a DO store', () => {
  it('books through the carrier service with no Postgres transaction', async () => {
    const r = await bookShipment({ storeId: DO_STORE, orderId: 'o1' });
    expect(r).toEqual({ shipmentId: 'sh1', status: 'created' });
    expect(h.createShipment).toHaveBeenCalledWith(DO_STORE, 'o1', undefined);
  });
});

describe('warehouse reconcile on a DO store', () => {
  it("the sweep's alarm finds the store with warehouses in its DO and reconciles through the DO stock op", async () => {
    h.doDb.warehouse.findFirst.mockResolvedValue({ storeId: DO_STORE });
    const r = await sweepAllWarehouseStores(step, alarm);
    expect(r).toMatchObject({ storesTotal: 1, storesSwept: 1, totalSkusReconciled: 3 });
    expect(h.stock.reconcileWarehouseAll).toHaveBeenCalledWith({ limit: 500, afterKey: null });
  });
  it('a store with no warehouse is not swept', async () => {
    h.doDb.warehouse.findFirst.mockResolvedValue(null);
    expect(await sweepAllWarehouseStores(step, alarm)).toMatchObject({ storesTotal: 0 });
    expect(h.stock.reconcileWarehouseAll).not.toHaveBeenCalled();
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
