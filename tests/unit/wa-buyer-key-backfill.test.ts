/** Skip paths of the buyer-key backfill (WA-BRIDGE-BIND-3): a gone store, a store not on a DO and a store whose DO throws are skipped and reported; the run goes on. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  d1: vi.fn(),
  lookup: vi.fn(),
  repo: vi.fn(),
  money: vi.fn(),
  log: vi.fn(),
}));
vi.mock('@api/services/platform/billing-d1', () => ({ d1All: h.d1 }));
vi.mock('@api/lib/definer', () => ({ lookupStore: h.lookup }));
vi.mock('@api/lib/logger', () => ({ default: { error: h.log, warn: vi.fn(), info: vi.fn() } }));
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

// ---- the `openUnkeyed` count is the number the rollout decision rests on: every condition of "open" must be load-bearing ----
type Row = {
  id: string;
  phone?: string;
  status: string;
  paymentStatus: string;
  providers: string[];
};
const shaped = (rows: Row[], seen?: { where?: Record<string, unknown> }) => ({
  backend: 'do',
  db: {
    order: {
      findMany: async (a: { where: Record<string, unknown> }) => {
        if (seen) seen.where = a.where;
        return rows.map(r => ({
          id: r.id,
          shippingAddress: r.phone ? { phone: r.phone } : {},
          status: r.status,
          paymentStatus: r.paymentStatus,
          payments: r.providers.map(provider => ({ provider })),
        }));
      },
    },
  },
});
const PH = '+201001234567';
const FIXTURE: Row[] = [
  { id: 'open-cod', phone: PH, status: 'pending', paymentStatus: 'unpaid', providers: ['cod'] }, // open, keyable
  {
    id: 'open-instapay',
    phone: PH,
    status: 'awaiting_payment_confirmation',
    paymentStatus: 'unpaid',
    providers: ['instapay'],
  }, // open, keyable
  {
    id: 'open-cod-confirmed-nophone',
    status: 'confirmed',
    paymentStatus: 'unpaid',
    providers: ['cod'],
  }, // open, NOT keyable
  { id: 'paid-cod', phone: PH, status: 'pending', paymentStatus: 'paid', providers: ['cod'] }, // closed by paymentStatus
  {
    id: 'cancelled-cod',
    phone: PH,
    status: 'cancelled',
    paymentStatus: 'unpaid',
    providers: ['cod'],
  }, // closed by status
  {
    id: 'delivered-cod',
    phone: PH,
    status: 'delivered',
    paymentStatus: 'unpaid',
    providers: ['cod'],
  }, // closed by status
  { id: 'shipped-cod', phone: PH, status: 'shipped', paymentStatus: 'unpaid', providers: ['cod'] }, // closed by status
  { id: 'card', phone: PH, status: 'pending', paymentStatus: 'unpaid', providers: ['paymob'] }, // not COD / InstaPay
  { id: 'no-payment-row', phone: PH, status: 'pending', paymentStatus: 'unpaid', providers: [] }, // not COD / InstaPay
  { id: 'paid-nophone', status: 'pending', paymentStatus: 'paid', providers: ['cod'] }, // no phone, closed
];

describe('openUnkeyed is exact (each of its three conditions fails a test when removed)', () => {
  beforeEach(() => {
    h.d1.mockReset().mockResolvedValue([{ id: 'd' }]);
    h.lookup.mockReset().mockResolvedValue({ id: 'd', status: 'active' });
    h.money.mockReset().mockResolvedValue({ ciOrderStamp: stamp });
  });
  it('counts only unpaid + open-status + COD/InstaPay orders, and splits out the unkeyable ones', async () => {
    const seen: { where?: Record<string, unknown> } = {};
    h.repo.mockReset().mockResolvedValue(shaped(FIXTURE, seen));
    const r = await runBuyerKeyBackfill({ secret: SECRET, dryRun: true, budget: 100 });
    // 3 open: open-cod, open-instapay, open-cod-confirmed-nophone. paid-cod / cancelled / delivered / shipped / card / no-payment-row are NOT.
    expect(r.totals).toMatchObject({
      scanned: 10,
      openUnkeyed: 3,
      openUnkeyedNoPhone: 1,
      noPhone: 2,
      keyed: 8,
    });
    expect(r.stores[0]).toMatchObject({ openUnkeyed: 3, openUnkeyedNoPhone: 1 });
    // only UNKEYED orders are read at all (a keyed order never reaches the count)
    expect(seen.where).toMatchObject({ storeId: 'd', buyerKey: null });
  });
  it('the same counts hold when applying (stamping does not change what was found)', async () => {
    h.repo.mockReset().mockResolvedValue(shaped(FIXTURE));
    const r = await runBuyerKeyBackfill({ secret: SECRET, dryRun: false, budget: 100 });
    expect(r.totals).toMatchObject({ openUnkeyed: 3, openUnkeyedNoPhone: 1, keyed: 8 });
    expect(stamp).toHaveBeenCalledTimes(8);
  });
  it.each([
    [
      'paid orders are not open',
      [{ id: 'a', phone: PH, status: 'pending', paymentStatus: 'paid', providers: ['cod'] }],
      0,
    ],
    [
      'cancelled / delivered / shipped orders are not open',
      FIXTURE.filter(o => ['cancelled-cod', 'delivered-cod', 'shipped-cod'].includes(o.id)),
      0,
    ],
    [
      'card and payment-less orders are not COD/InstaPay',
      FIXTURE.filter(o => ['card', 'no-payment-row'].includes(o.id)),
      0,
    ],
    ['an open instapay order is counted', FIXTURE.filter(o => o.id === 'open-instapay'), 1],
  ])('%s', async (_n, rows, expected) => {
    h.repo.mockReset().mockResolvedValue(shaped(rows as Row[]));
    expect((await runBuyerKeyBackfill({ secret: SECRET, dryRun: true })).totals.openUnkeyed).toBe(
      expected
    );
  });
});

describe('a failing store is logged with its id and error code and recorded in the result', () => {
  it('logs, reports errorCode + failed[], and a rerun limited to that store retries it', async () => {
    h.d1.mockReset().mockResolvedValue([{ id: 'x' }, { id: 'y' }]);
    h.lookup.mockReset().mockResolvedValue({ id: 'x', status: 'active' });
    h.money.mockReset().mockResolvedValue({ ciOrderStamp: stamp });
    h.log.mockReset();
    let broken = true;
    h.repo.mockReset().mockImplementation(async (id: string) => {
      if (id === 'x' && broken)
        throw Object.assign(new Error('do overloaded'), { code: 'DO_OVERLOADED' });
      return shaped([
        { id: 'o', phone: PH, status: 'pending', paymentStatus: 'unpaid', providers: ['cod'] },
      ]);
    });
    const r = await runBuyerKeyBackfill({ secret: SECRET, dryRun: false, budget: 100 });
    expect(r.stores.find(s => s.storeId === 'x')).toMatchObject({
      skipped: 'error',
      errorCode: 'DO_OVERLOADED',
      done: true,
    });
    expect(r.failed).toEqual([{ storeId: 'x', code: 'DO_OVERLOADED' }]);
    expect(r.stores.find(s => s.storeId === 'y')).toMatchObject({ keyed: 1, skipped: null }); // the run went on
    expect(h.log).toHaveBeenCalledWith(
      { storeId: 'x', code: 'DO_OVERLOADED' },
      expect.stringContaining('store failed')
    );
    // retry just that store once it recovers
    broken = false;
    h.d1.mockResolvedValue([{ id: 'x' }]);
    const again = await runBuyerKeyBackfill({
      secret: SECRET,
      dryRun: false,
      budget: 100,
      storeId: 'x',
    });
    expect(again.failed).toEqual([]);
    expect(again.totals.keyed).toBe(1);
  });
});
