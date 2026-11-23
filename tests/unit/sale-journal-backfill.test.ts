/** Sale-journal backfill: dry-run lists, apply posts only the journal, a rerun posts nothing, never order/created. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  d1: vi.fn(),
  lookup: vi.fn(),
  repo: vi.fn(),
  money: vi.fn(),
  send: vi.fn(),
}));
vi.mock('@api/services/platform/billing-d1', () => ({ d1All: h.d1 }));
vi.mock('@api/lib/definer', () => ({ lookupStore: h.lookup }));
vi.mock('@api/lib/logger', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@api/lib/repo-factory', () => ({ storeRepo: h.repo, storeMoney: h.money }));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: h.send, createFunction: vi.fn() } }));

import { runSaleJournalBackfill } from '@api/lib/accounting/sale-journal-backfill';

// store s1: o1 paid, no entry (the lost mark-paid) | o2 paid, already journalled | o3 paid, no entry, accounting off
// the order query itself excludes cancelled/refunded + unpaid, asserted via the `where` it receives.
const journalled = new Set<string>(['o2']);
const wheres: unknown[] = [];
const journalSale = vi.fn(async ({ orderId }: { orderId: string }) => {
  if (orderId === 'o3') return { posted: false, skipped: 'accounting_disabled', entries: 0 };
  journalled.add(orderId);
  return { posted: true, entries: 2 };
});

beforeEach(() => {
  journalled.clear();
  journalled.add('o2');
  wheres.length = 0;
  journalSale.mockClear();
  h.send.mockClear();
  h.d1.mockReset().mockResolvedValue([{ id: 's1' }, { id: 'gone' }, { id: 'pg' }]);
  h.lookup
    .mockReset()
    .mockImplementation(async ({ id }: { id: string }) => (id === 'gone' ? null : { id }));
  h.money
    .mockReset()
    .mockImplementation(async (id: string) => (id === 'pg' ? null : { journalSale }));
  h.repo.mockReset().mockImplementation(async (id: string) =>
    id === 'pg'
      ? { backend: 'pg' }
      : {
          backend: 'do',
          db: {
            order: {
              findMany: async (a: { where: unknown }) => {
                wheres.push(a.where);
                return [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }];
              },
            },
            journalEntry: {
              findFirst: async ({ where }: { where: { sourceId: string } }) =>
                journalled.has(where.sourceId) ? { id: 'je' } : null,
            },
          },
        }
  );
});

describe('runSaleJournalBackfill', () => {
  it('dry run (the default) lists the missing orders per store and posts nothing', async () => {
    const r = await runSaleJournalBackfill({ dryRun: true });
    expect(journalSale).not.toHaveBeenCalled();
    const s1 = r.stores.find(s => s.storeId === 's1')!;
    expect(s1.orderIds).toEqual(['o1', 'o3']);
    expect(s1.candidates).toBe(2);
    expect(s1.posted).toBe(0);
    expect(r.stores.find(s => s.storeId === 'gone')!.storeSkipped).toBe('gone');
    expect(r.stores.find(s => s.storeId === 'pg')!.storeSkipped).toBe('not_do');
    expect(wheres[0]).toMatchObject({
      paymentStatus: 'paid',
      status: { notIn: ['cancelled', 'refunded'] },
    });
  });

  it('apply posts only the journal for the missing paid orders; accounting-off is reported, not forced', async () => {
    const r = await runSaleJournalBackfill({ dryRun: false });
    expect(journalSale.mock.calls.map(c => c[0].orderId)).toEqual(['o1', 'o3']);
    const s1 = r.stores.find(s => s.storeId === 's1')!;
    expect(s1.posted).toBe(1);
    expect(s1.skipped).toEqual({ accounting_disabled: 1 });
    expect(h.send).not.toHaveBeenCalled(); // never order/created: no email / push re-sent
  });

  it('is idempotent: a second apply finds only what journalSale declined', async () => {
    await runSaleJournalBackfill({ dryRun: false });
    journalSale.mockClear();
    const r = await runSaleJournalBackfill({ dryRun: false });
    expect(journalSale.mock.calls.map(c => c[0].orderId)).toEqual(['o3']);
    expect(r.stores.find(s => s.storeId === 's1')!.posted).toBe(0);
  });

  it('one failing order does not stop the run', async () => {
    journalSale.mockImplementationOnce(async () => {
      throw Object.assign(new Error('x'), { code: 'DO_DOWN' });
    });
    const r = await runSaleJournalBackfill({ dryRun: false });
    const s1 = r.stores.find(s => s.storeId === 's1')!;
    expect(s1.errors).toEqual([{ orderId: 'o1', code: 'DO_DOWN' }]);
    expect(journalSale).toHaveBeenCalledTimes(2);
  });
});
