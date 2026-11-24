/** Sale-journal backfill: gates, partial-refund replay, reasons in the dry run, budget counts every store visited. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  d1: vi.fn(),
  dir: vi.fn(),
  lookup: vi.fn(),
  repo: vi.fn(),
  money: vi.fn(),
  send: vi.fn(),
  feature: vi.fn(),
}));
vi.mock('@api/services/platform/billing-d1', () => ({ d1All: h.d1 }));
vi.mock('@api/lib/jobs/store-db', () => ({ allStoresDirectory: h.dir }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: h.feature },
}));
vi.mock('@api/lib/definer', () => ({ lookupStore: h.lookup }));
vi.mock('@api/lib/logger', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@api/lib/repo-factory', () => ({ storeRepo: h.repo, storeMoney: h.money }));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: h.send, createFunction: vi.fn() } }));

import { runSaleJournalBackfill } from '@api/lib/accounting/sale-journal-backfill';

// s1: o1 paid, no sale, no refunds | o2 paid, sale exists | o3 paid, no sale, a return (items) THEN an amount-only refund
//     o4 fully refunded | o5 cancelled | o6 paid, no sale, accounting declines at journalSale
// source ids of journal entries -> createdAt (ms); the sale of a run is stamped AFTER every refund event below
const journalled = new Map<string, number>([['o2', 500]]);
const calls: string[] = [];
const journalSale = vi.fn(async ({ orderId }: { orderId: string }) => {
  calls.push(`sale:${orderId}`);
  if (orderId === 'o6') return { posted: false, skipped: 'accounting_disabled', entries: 0 };
  journalled.set(orderId, 5000);
  return { posted: true, entries: 2 };
});
const journalPartialReturn = vi.fn(async (a: { orderId: string; refundKey: string }) => {
  calls.push(`return:${a.refundKey}`);
  journalled.set(`${a.orderId}:partial:${a.refundKey}`, 5001);
  return { posted: 2 };
});
const journalAmountOnlyRefund = vi.fn(async (a: { orderId: string; refundKey: string }) => {
  calls.push(`amount:${a.refundKey}`);
  journalled.set(`${a.orderId}:partial:${a.refundKey}`, 5001);
  return { posted: 1 };
});

const ORDERS = [
  { id: 'o1', status: 'delivered', paymentStatus: 'paid' },
  { id: 'o2', status: 'delivered', paymentStatus: 'paid' },
  { id: 'o3', status: 'delivered', paymentStatus: 'paid' },
  { id: 'o4', status: 'refunded', paymentStatus: 'refunded' },
  { id: 'o5', status: 'cancelled', paymentStatus: 'paid' },
  { id: 'o6', status: 'delivered', paymentStatus: 'paid' },
];
const EVENTS: Record<string, Record<string, unknown[]>> = {
  o3: {
    partial_return_restored: [
      {
        createdAt: new Date(1000),
        metadata: { refundKey: 'ret-1', items: [{ orderItemId: 'i1', quantity: 1 }] },
      },
    ],
    backorder_line_cancelled: [
      {
        createdAt: new Date(1500),
        metadata: { refundKey: 'backorder:line1', items: [{ orderItemId: 'i2', quantity: 2 }] },
      },
    ],
    partial_refund_recorded: [
      { createdAt: new Date(2000), metadata: { refundKey: 'refund:re_9', amount: 3000 } },
    ],
  },
};
const repoFor = () => ({
  backend: 'do',
  db: {
    order: { findMany: async () => ORDERS },
    journalEntry: {
      findFirst: async ({ where }: { where: { sourceId: string | { in: string[] } } }) => {
        const ids = typeof where.sourceId === 'string' ? [where.sourceId] : where.sourceId.in;
        const hit = ids.find(i => journalled.has(i));
        return hit ? { id: 'je', createdAt: new Date(journalled.get(hit)!) } : null;
      },
    },
    orderEvent: {
      findMany: async ({ where }: { where: { orderId: string; toStatus: string } }) =>
        EVENTS[where.orderId]?.[where.toStatus] ?? [],
    },
  },
});

beforeEach(() => {
  journalled.clear();
  journalled.set('o2', 500);
  calls.length = 0;
  for (const f of [journalSale, journalPartialReturn, journalAmountOnlyRefund, h.send])
    f.mockClear();
  h.d1
    .mockReset()
    .mockResolvedValue([
      { id: 's1' },
      { id: 'sGone' },
      { id: 'sOff' },
      { id: 'sPlan' },
      { id: 'sPg' },
    ]);
  h.dir
    .mockReset()
    .mockResolvedValue(
      ['s1', 'sGone', 'sOff', 'sPlan', 'sPg'].map(id => ({ id, accountingEnabled: id !== 'sOff' }))
    );
  h.feature.mockReset().mockImplementation(async (id: string) => id !== 'sPlan');
  h.lookup
    .mockReset()
    .mockImplementation(async ({ id }: { id: string }) => (id === 'sGone' ? null : { id }));
  h.money
    .mockReset()
    .mockImplementation(async (id: string) =>
      id === 'sPg' ? null : { journalSale, journalPartialReturn, journalAmountOnlyRefund }
    );
  h.repo
    .mockReset()
    .mockImplementation(async (id: string) => (id === 'sPg' ? { backend: 'pg' } : repoFor()));
});

describe('runSaleJournalBackfill', () => {
  it('dry run (default) posts nothing and reports counts by reason, store skips included', async () => {
    const r = await runSaleJournalBackfill({ dryRun: true });
    expect(journalSale).not.toHaveBeenCalled();
    expect(journalPartialReturn).not.toHaveBeenCalled();
    const s1 = r.stores.find(s => s.storeId === 's1')!;
    expect(s1.orderIds).toEqual(['o1', 'o3', 'o6']);
    expect(s1.candidates).toBe(3);
    expect(s1.reasons).toMatchObject({
      already_journaled: 1,
      fully_refunded: 1,
      cancelled: 1,
      partial_refund_replay_needed: 1,
    });
    expect(r.totals.byReason).toMatchObject({
      store_gone: 1,
      store_accounting_off: 1,
      store_plan_gate: 1,
      store_not_do: 1,
    });
    expect(r.totals.storesVisited).toBe(5);
  });

  it('apply posts the sale then replays the skipped refunds oldest-first; a fully paid order has no replay', async () => {
    const r = await runSaleJournalBackfill({ dryRun: false });
    expect(calls).toEqual([
      'sale:o1',
      'sale:o3',
      'return:ret-1',
      'return:backorder:line1',
      'amount:refund:re_9',
      'sale:o6',
    ]);
    expect(journalPartialReturn).toHaveBeenCalledWith({
      orderId: 'o3',
      refundKey: 'ret-1',
      items: [{ orderItemId: 'i1', quantity: 1 }],
    });
    expect(journalPartialReturn).toHaveBeenCalledWith({
      orderId: 'o3',
      refundKey: 'backorder:line1',
      items: [{ orderItemId: 'i2', quantity: 2 }],
    });
    expect(journalAmountOnlyRefund).toHaveBeenCalledWith({
      orderId: 'o3',
      refundKey: 'refund:re_9',
      amount: 3000,
    });
    const s1 = r.stores.find(s => s.storeId === 's1')!;
    expect(s1.posted).toBe(2);
    expect(s1.reasons).toMatchObject({ refunds_replayed: 3, sale_skipped_accounting_disabled: 1 });
    expect(h.send).not.toHaveBeenCalled(); // never order/created: no email / push re-sent
  });

  it('is idempotent: a second apply posts no sale and replays nothing', async () => {
    await runSaleJournalBackfill({ dryRun: false });
    calls.length = 0;
    await runSaleJournalBackfill({ dryRun: false });
    expect(calls).toEqual(['sale:o6']); // only the one journalSale declines
  });

  it('a replay that failed after the sale posted is retried on the next run', async () => {
    journalPartialReturn
      .mockImplementationOnce(async (a: { orderId: string; refundKey: string }) => {
        calls.push(`return:${a.refundKey}`);
        journalled.set(`${a.orderId}:partial:${a.refundKey}`, 5001);
        return { posted: 2 };
      })
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('x'), { code: 'DO_DOWN' });
      });
    const first = await runSaleJournalBackfill({ dryRun: false });
    expect(first.stores[0].errors).toEqual([{ orderId: 'o3', code: 'DO_DOWN' }]);
    calls.length = 0;
    const dry = await runSaleJournalBackfill({ dryRun: true });
    expect(dry.stores[0].reasons.refund_replay_needed).toBe(1);
    expect(calls).toEqual([]);
    const second = await runSaleJournalBackfill({ dryRun: false });
    expect(calls).toEqual(['return:backorder:line1', 'amount:refund:re_9', 'sale:o6']);
    expect(second.stores[0].reasons.refunds_replayed).toBe(2);
    calls.length = 0;
    await runSaleJournalBackfill({ dryRun: false });
    expect(calls).toEqual(['sale:o6']);
  });

  it('a refund made AFTER the sale existed is never replayed', async () => {
    journalled.set('o3', 100); // the sale predates every refund event (t >= 1000)
    const r = await runSaleJournalBackfill({ dryRun: false });
    expect(journalPartialReturn).not.toHaveBeenCalled();
    expect(journalAmountOnlyRefund).not.toHaveBeenCalled();
    expect(r.stores[0].reasons.refund_replay_needed).toBeUndefined();
  });

  it('a failing order is listed and does not stop the run', async () => {
    journalSale.mockImplementationOnce(async () => {
      throw Object.assign(new Error('x'), { code: 'DO_DOWN' });
    });
    const r = await runSaleJournalBackfill({ dryRun: false });
    expect(r.stores.find(s => s.storeId === 's1')!.errors).toEqual([
      { orderId: 'o1', code: 'DO_DOWN' },
    ]);
    expect(calls).toContain('sale:o3');
  });

  it('the budget counts every store visited, so an idle fleet stops and hands back a cursor', async () => {
    h.d1.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ id: `idle${i}` })));
    h.dir.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ id: `idle${i}`, accountingEnabled: false }))
    );
    const r = await runSaleJournalBackfill({ dryRun: true, budget: 4 });
    expect(r.totals.storesVisited).toBeLessThanOrEqual(3);
    expect(r.nextCursor).not.toBeNull();
  });
});
