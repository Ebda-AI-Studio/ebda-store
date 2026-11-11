/** Skip paths of the buyer-key backfill (WA-BRIDGE-BIND-3): a gone store, a store not on a DO and a store whose DO throws are skipped and reported; the run goes on. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ d1: vi.fn(), lookup: vi.fn(), repo: vi.fn(), money: vi.fn() }));
vi.mock('@api/services/platform/billing-d1', () => ({ d1All: h.d1 }));
vi.mock('@api/lib/definer', () => ({ lookupStore: h.lookup }));
vi.mock('@api/lib/repo-factory', () => ({ storeRepo: h.repo, storeMoney: h.money }));

import { runBuyerKeyBackfill, encodeCursor, decodeCursor } from '@api/lib/wa/buyer-key-backfill';

const SECRET = 'unit-test-suite-secret-at-least-32-chars!!';
const stamp = vi.fn(async () => ({ stamped: true }));
const orders = (rows: Array<{ id: string; phone?: string; open?: boolean }>) => ({
  backend: 'do',
  db: {
    order: {
      findMany: async () =>
        rows.map(r => ({
          id: r.id,
          shippingAddress: r.phone ? { phone: r.phone } : {},
          status: 'pending',
          paymentStatus: r.open === false ? 'paid' : 'unpaid',
          payments: [{ provider: 'cod' }],
        })),
    },
  },
});

beforeEach(() => {
  stamp.mockClear();
  h.d1.mockReset().mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
  h.lookup
    .mockReset()
    .mockImplementation(async ({ id }: { id: string }) =>
      id === 'a' ? null : { id, status: 'active' }
    );
  h.money
    .mockReset()
    .mockImplementation(async (id: string) => (id === 'b' ? null : { ciOrderStamp: stamp }));
  h.repo.mockReset().mockImplementation(async (id: string) => {
    if (id === 'c') throw new Error('DO unavailable');
    if (id === 'b') return { backend: 'pg' };
    return orders([{ id: 'o1', phone: '+201001234567' }, { id: 'o2' }]);
  });
});

describe('buyer-key backfill skip paths', () => {
  it('skips gone, not-DO and failing stores, reports each, and still processes the healthy one', async () => {
    const r = await runBuyerKeyBackfill({ secret: SECRET, dryRun: false, budget: 100 });
    expect(r.stores.map(s => [s.storeId, s.skipped])).toEqual([
      ['a', 'gone'],
      ['b', 'not_do'],
      ['c', 'error'],
      ['d', null],
    ]);
    expect(r.totals).toMatchObject({
      skippedStores: 3,
      keyed: 1,
      noPhone: 1,
      scanned: 2,
      openUnkeyed: 2,
      openUnkeyedNoPhone: 1,
    });
    expect(stamp).toHaveBeenCalledTimes(1);
  });
  it('dry run never calls the stamp op', async () => {
    await runBuyerKeyBackfill({ secret: SECRET, dryRun: true, budget: 100 });
    expect(stamp).not.toHaveBeenCalled();
  });
  it('a malformed cursor is ignored (start over), a valid one round-trips', () => {
    expect(decodeCursor('not-base64-json')).toBeNull();
    expect(decodeCursor(encodeCursor({ s: 'x', o: 'y' }))).toEqual({ s: 'x', o: 'y' });
  });
  it('refuses a short secret', async () => {
    await expect(runBuyerKeyBackfill({ secret: 'short', dryRun: true })).rejects.toThrow(
      'SUITE_BUYER_KEY_SECRET'
    );
  });
});
