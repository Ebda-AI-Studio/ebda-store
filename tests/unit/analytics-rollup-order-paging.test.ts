/**
 * M-048 — the nightly cohort/RFM rollups loaded EVERY paid order in one query. They now walk the
 * orders in keyset pages. Mutation-proof: dropping `take`/`cursor` from the helper reddens the
 * page-size and no-duplicate cases.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@ebda/database', () => ({ prisma: {}, RfmSegment: {}, withRlsBypass: vi.fn() }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { forEachPaidOrderPage } from '@api/services/accounting/analytics-rollup.service';

type Args = { take?: number; cursor?: { id: string }; skip?: number };
function fakeDb(total: number) {
  const rows = Array.from({ length: total }, (_, i) => ({
    id: `o${String(i).padStart(4, '0')}`,
    customerId: 'c',
    shippingAddress: null,
    createdAt: new Date(2026, 0, 1 + i),
    total: 1,
  }));
  const calls: Args[] = [];
  const db = {
    order: {
      findMany: async (a: Args) => {
        calls.push(a);
        const start = a.cursor ? rows.findIndex(r => r.id === a.cursor!.id) + (a.skip ?? 0) : 0;
        return rows.slice(start, start + (a.take ?? rows.length));
      },
    },
    // each page is netted of its refunds (REVENUE-DEF-1, lib/order-refunds.ts): none here
    return: { groupBy: async () => [] },
    payment: { groupBy: async () => [] },
  };
  return { db: db as never, calls };
}

describe('forEachPaidOrderPage (M-048)', () => {
  it('reads in bounded pages and visits every order exactly once', async () => {
    const { db, calls } = fakeDb(2503);
    const seen: string[] = [];
    let maxPage = 0;
    await forEachPaidOrderPage(db, 's1', p => {
      maxPage = Math.max(maxPage, p.length);
      seen.push(...p.map(o => o.id));
    });
    expect(maxPage).toBe(1000);
    expect(calls.length).toBe(3);
    expect(seen.length).toBe(2503);
    expect(new Set(seen).size).toBe(2503);
  });

  it('exact multiple of the page size ends on the empty page, empty store never calls back', async () => {
    const a = fakeDb(2000);
    let n = 0;
    await forEachPaidOrderPage(a.db, 's1', p => (n += p.length));
    expect(n).toBe(2000);
    expect(a.calls.length).toBe(3);
    const b = fakeDb(0);
    const cb = vi.fn();
    await forEachPaidOrderPage(b.db, 's1', cb);
    expect(cb).not.toHaveBeenCalled();
  });
});
