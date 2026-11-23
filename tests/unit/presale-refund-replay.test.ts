/** A refund booked before the sale journal exists gets its journal when the sale posts (normal flow, not the backfill). */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ money: vi.fn(), repo: vi.fn() }));
vi.mock('@ebda/database', () => ({
  prisma: {},
  currentStoreId: () => 's1',
}));
vi.mock('@api/lib/repo-factory', () => ({ storeMoney: h.money, storeRepo: h.repo }));
vi.mock('@api/lib/logger', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@api/services/accounting/account.service', () => ({ getSystemAccountIdByCode: vi.fn() }));
vi.mock('@api/services/accounting/journal.service', () => ({ postEntry: vi.fn() }));

import { postOrderPaymentJournal } from '@api/services/accounting/posting/order-posting';

// the ledger: source ids -> createdAt. The money ops write it the way the DO does (skip when no sale; skip when already posted).
const ledger = new Map<string, number>();
let clock = 10_000;
const events: Record<string, unknown[]> = {};
let saleDeclines: string | null = null;

const journalSale = vi.fn(async ({ orderId }: { orderId: string }) => {
  if (saleDeclines) return { posted: false, skipped: saleDeclines, entries: 0 };
  if (!ledger.has(orderId)) ledger.set(orderId, clock++);
  return { posted: true, entries: 2 };
});
const refundOp = (kind: string) =>
  vi.fn(async (a: { orderId: string; refundKey: string }) => {
    const id = `${a.orderId}:partial:${a.refundKey}`;
    if (!ledger.has(a.orderId)) return { posted: 0, skipped: 'no-original-entry' };
    if (ledger.has(id)) return { posted: 0, skipped: 'already-posted' };
    ledger.set(id, clock++);
    void kind;
    return { posted: 2 };
  });
const journalPartialReturn = refundOp('return');
const journalAmountOnlyRefund = refundOp('amount');

beforeEach(() => {
  ledger.clear();
  clock = 10_000;
  saleDeclines = null;
  for (const k of Object.keys(events)) delete events[k];
  for (const f of [journalSale, journalPartialReturn, journalAmountOnlyRefund]) f.mockClear();
  h.money
    .mockReset()
    .mockResolvedValue({ journalSale, journalPartialReturn, journalAmountOnlyRefund });
  h.repo.mockReset().mockResolvedValue({
    backend: 'do',
    db: {
      journalEntry: {
        findFirst: async ({ where }: { where: { sourceId: string | { in: string[] } } }) => {
          const ids = typeof where.sourceId === 'string' ? [where.sourceId] : where.sourceId.in;
          const hit = ids.find(i => ledger.has(i));
          return hit ? { id: 'je', createdAt: new Date(ledger.get(hit)!) } : null;
        },
      },
      orderEvent: {
        findMany: async ({ where }: { where: { orderId: string; toStatus: string } }) =>
          (events[where.orderId] ?? []).filter(
            e => (e as { toStatus: string }).toStatus === where.toStatus
          ),
      },
    },
  });
});

const ev = (toStatus: string, at: number, metadata: Record<string, unknown>) => ({
  toStatus,
  createdAt: new Date(at),
  metadata,
});

describe('sale posting replays pre-sale refund journals', () => {
  it('a return before the sale: the refund journal appears once the sale posts', async () => {
    events.o1 = [
      ev('partial_return_restored', 1000, {
        refundKey: 'ret-1',
        items: [{ orderItemId: 'i', quantity: 1 }],
      }),
      ev('partial_refund_recorded', 2000, { refundKey: 'refund:re_1', amount: 4000 }),
    ];
    // the refund's own journal was attempted at the time and skipped: no sale yet
    expect((await journalPartialReturn({ orderId: 'o1', refundKey: 'ret-1' })).skipped).toBe(
      'no-original-entry'
    );
    expect(ledger.has('o1:partial:ret-1')).toBe(false);

    await postOrderPaymentJournal({ orderId: 'o1' });

    expect(ledger.has('o1')).toBe(true);
    expect(ledger.has('o1:partial:ret-1')).toBe(true);
    expect(ledger.has('o1:partial:refund:re_1')).toBe(true);
  });

  it('is idempotent and a retry after a half-done replay completes it', async () => {
    events.o1 = [
      ev('partial_return_restored', 1000, {
        refundKey: 'ret-1',
        items: [{ orderItemId: 'i', quantity: 1 }],
      }),
      ev('partial_refund_recorded', 2000, { refundKey: 'refund:re_1', amount: 4000 }),
    ];
    journalAmountOnlyRefund.mockImplementationOnce(async () => {
      throw new Error('DO down');
    });
    await expect(postOrderPaymentJournal({ orderId: 'o1' })).rejects.toThrow('DO down');
    expect(ledger.has('o1')).toBe(true);
    expect(ledger.has('o1:partial:ret-1')).toBe(true);
    expect(ledger.has('o1:partial:refund:re_1')).toBe(false);

    await postOrderPaymentJournal({ orderId: 'o1' }); // the step retry
    expect(ledger.has('o1:partial:refund:re_1')).toBe(true);
    const n = journalPartialReturn.mock.calls.length + journalAmountOnlyRefund.mock.calls.length;
    await postOrderPaymentJournal({ orderId: 'o1' });
    // a third pass finds nothing pending: no further money-op calls
    expect(journalPartialReturn.mock.calls.length + journalAmountOnlyRefund.mock.calls.length).toBe(
      n
    );
  });

  it('a refund made after the sale existed is left to the normal flow', async () => {
    ledger.set('o1', 500); // sale already there, older than the refund below
    events.o1 = [ev('partial_refund_recorded', 2000, { refundKey: 'refund:re_1', amount: 4000 })];
    await postOrderPaymentJournal({ orderId: 'o1' });
    expect(journalAmountOnlyRefund).not.toHaveBeenCalled();
  });

  it('a refund stamped in the same millisecond as the sale entry is still replayed', async () => {
    ledger.set('o1', 2000); // sale entry at t=2000, same ms as the refund event below
    events.o1 = [ev('partial_refund_recorded', 2000, { refundKey: 'refund:re_1', amount: 4000 })];
    await postOrderPaymentJournal({ orderId: 'o1' });
    expect(ledger.has('o1:partial:refund:re_1')).toBe(true);
  });

  it('no replay when the sale itself was declined (accounting off / not paid)', async () => {
    saleDeclines = 'accounting_disabled';
    events.o1 = [ev('partial_refund_recorded', 2000, { refundKey: 'refund:re_1', amount: 4000 })];
    await postOrderPaymentJournal({ orderId: 'o1' });
    expect(journalAmountOnlyRefund).not.toHaveBeenCalled();
  });

  it('an order with no refunds costs no money-op calls beyond the sale', async () => {
    await postOrderPaymentJournal({ orderId: 'o2' });
    expect(journalPartialReturn).not.toHaveBeenCalled();
    expect(journalAmountOnlyRefund).not.toHaveBeenCalled();
  });
});
