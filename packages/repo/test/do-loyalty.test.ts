// DO loyalty port: earn / redeem / reverse rules on node:sqlite (real StoreDO schema), plus a differential of the pure
// rounding helpers against the Postgres original (apps/api/src/services/loyalty.service.ts).
import { describe, expect, it, vi } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import {
  calculateTier,
  computeEarnPoints,
  computeRedemption,
  earnPointsFromPurchase,
  getRedeemableContext,
  mergeSettings,
  quoteRedemption,
  redeemPoints,
  reverseEarnedPointsFromOrder,
  reverseRedeemedPointsFromOrder,
  DEFAULT_LOYALTY_SETTINGS,
} from '../src/do/loyalty';
import { MoneyError } from '../src/do/sync-sql';
import { fromMinor } from '../../shared/src/region';

// The original module pulls the Prisma client at import; only its PURE exports are under test, so stub the I/O edges.
vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  LoyaltyTransactionType: {},
  withMoneyTx: () => undefined,
  withStore: () => undefined,
}));
vi.mock('@ebda/shared', async () => await import('../../shared/src/region'));
// repo-factory -> store-update-retry statically imports the alert sender (an I/O edge that loads the whole API config).
vi.mock('../../../apps/api/src/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('../../../apps/api/src/middleware/error-handler', () => ({
  AppError: class extends Error {},
}));
vi.mock('../../../apps/api/src/lib/logger', () => ({ default: {} }));
vi.mock('../../../apps/api/src/services/feature.service', () => ({ featureService: {} }));

function fixture(settings: Record<string, unknown> = {}, enabled = 1) {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...(p as never[]));
  const one = <T = Record<string, number>>(sql: string, ...p: unknown[]) =>
    raw.prepare(sql).get(...(p as never[])) as T;
  for (const s of ['s1', 's2'])
    x(
      `INSERT INTO store_config (store_id, loyalty_enabled, loyalty_settings) VALUES (?, ?, ?)`,
      s,
      enabled,
      JSON.stringify(settings)
    );
  x(`INSERT INTO customers (id, store_id, first_name, last_name) VALUES ('c1', 's1', 'A', 'B')`);
  x(`INSERT INTO customers (id, store_id, first_name, last_name) VALUES ('c2', 's1', 'C', 'D')`);
  x(`INSERT INTO customers (id, store_id, first_name, last_name) VALUES ('x1', 's2', 'E', 'F')`);
  let n = 0;
  const order = (
    storeId: string,
    customerId: string | null,
    subtotal: number,
    total = subtotal
  ) => {
    const oid = `o${++n}`;
    x(
      `INSERT INTO orders (id, store_id, customer_id, order_number, subtotal, total, shipping_address, billing_address) VALUES (?, ?, ?, ?, ?, ?, '{}', '{}')`,
      oid,
      storeId,
      customerId,
      `N${n}`,
      subtotal,
      total
    );
    return oid;
  };
  const points = (storeId: string, customerId: string, p: number, earned = p) =>
    x(
      `INSERT INTO loyalty_points (id, store_id, customer_id, points, total_earned) VALUES (?, ?, ?, ?, ?)`,
      `lp-${storeId}-${customerId}`,
      storeId,
      customerId,
      p,
      earned
    );
  const bal = (storeId: string, customerId: string) =>
    one<{ points: number; total_earned: number; total_redeemed: number; tier: string }>(
      `SELECT points, total_earned, total_redeemed, tier FROM loyalty_points WHERE store_id = ? AND customer_id = ?`,
      storeId,
      customerId
    );
  const txCount = (where: string) =>
    one<{ n: number }>(`SELECT count(*) n FROM loyalty_transactions WHERE ${where}`).n;
  return { raw, db, x, one, order, points, bal, txCount };
}
const err = (fn: () => unknown): MoneyError => {
  try {
    fn();
  } catch (e) {
    return e as MoneyError;
  }
  throw new Error('expected a MoneyError');
};
const F = { featureEnabled: true };

describe('loyalty: settings', () => {
  it('merges over the defaults like the original and falls back on hostile stored values', () => {
    expect(mergeSettings({ minRedeemPoints: 100 }).minRedeemPoints).toBe(100);
    expect(mergeSettings({ minRedeemPoints: 100 }).pointsValue).toBe(1);
    const bad = mergeSettings({
      pointsValue: 'x',
      minRedeemPoints: NaN,
      tiers: { gold: { minPoints: 1 } },
    });
    expect(bad.pointsValue).toBe(1);
    expect(bad.minRedeemPoints).toBe(500);
    expect(bad.tiers).toEqual(DEFAULT_LOYALTY_SETTINGS.tiers);
    expect(mergeSettings(null)).toEqual(DEFAULT_LOYALTY_SETTINGS);
    expect(mergeSettings([1, 2])).toEqual(DEFAULT_LOYALTY_SETTINGS);
  });
  it('a store with loyalty off, no config row, or the feature off redeems nothing', () => {
    const f = fixture({}, 0);
    f.points('s1', 'c1', 5000);
    expect(getRedeemableContext(f.db, { storeId: 's1', customerId: 'c1', ...F })).toBeNull();
    const g = fixture();
    g.points('s1', 'c1', 5000);
    expect(
      getRedeemableContext(g.db, { storeId: 's1', customerId: 'c1', featureEnabled: false })
    ).toBeNull();
    expect(getRedeemableContext(g.db, { storeId: 'nope', customerId: 'c1', ...F })).toBeNull();
    expect(getRedeemableContext(g.db, { storeId: 's1', customerId: 'c1', ...F })).toMatchObject({
      availablePoints: 5000,
    });
    expect(
      quoteRedemption(g.db, {
        storeId: 's1',
        customerId: 'c1',
        requestedPoints: 1000,
        subtotal: 10000,
        ...F,
      })
    ).toEqual({ pointsToRedeem: 1000, discountFils: 1000, applied: true });
  });
});

describe('loyalty: earn', () => {
  it('floor(floor(EGP * rate) * tier multiplier), the tier moves, a tier_changed row is written', () => {
    const f = fixture();
    const o = f.order('s1', 'c1', 12345); // 123.45 EGP -> 123 base
    const r = earnPointsFromPurchase(f.db, { storeId: 's1', customerId: 'c1', orderId: o, ...F });
    expect(r).toEqual({ pointsEarned: 123, newBalance: 123, replayed: false });
    expect(f.bal('s1', 'c1')).toMatchObject({ points: 123, total_earned: 123, tier: 'bronze' });
    // silver (x1.25): 1000 earned so far
    f.x(`UPDATE loyalty_points SET total_earned = 1000, points = 1000 WHERE customer_id = 'c1'`);
    const o2 = f.order('s1', 'c1', 10001); // 100.01 -> 100 base * 1.25 = 125
    expect(
      earnPointsFromPurchase(f.db, { storeId: 's1', customerId: 'c1', orderId: o2, ...F })
    ).toMatchObject({ pointsEarned: 125, newBalance: 1125 });
    expect(f.bal('s1', 'c1').tier).toBe('silver');
    expect(f.txCount(`type = 'tier_changed' AND order_id = '${o2}'`)).toBe(1);
  });

  it('a replay never double-earns (ledger key), and a different order earns separately', () => {
    const f = fixture();
    const o = f.order('s1', 'c1', 20000);
    const args = { storeId: 's1', customerId: 'c1', orderId: o, ...F };
    expect(earnPointsFromPurchase(f.db, args).pointsEarned).toBe(200);
    const again = earnPointsFromPurchase(f.db, args);
    expect(again).toEqual({ pointsEarned: 0, newBalance: 200, replayed: true });
    expect(f.bal('s1', 'c1').points).toBe(200);
    expect(f.txCount(`type = 'earn_purchase'`)).toBe(1);
    // the unique index is the backstop even for a writer that bypasses the check
    expect(() =>
      f.x(
        `INSERT INTO loyalty_transactions (id, store_id, customer_id, order_id, type, points) VALUES ('dup', 's1', 'c1', '${o}', 'earn_purchase', 5)`
      )
    ).toThrow();
  });

  it('refuses an order of another store or customer, a bad id, and earns nothing when the feature is off', () => {
    const f = fixture();
    const foreign = f.order('s2', 'x1', 5000);
    expect(
      err(() =>
        earnPointsFromPurchase(f.db, { storeId: 's1', customerId: 'c1', orderId: foreign, ...F })
      ).code
    ).toBe('ORDER_NOT_FOUND');
    const mine = f.order('s1', 'c1', 5000);
    expect(
      err(() =>
        earnPointsFromPurchase(f.db, { storeId: 's1', customerId: 'c2', orderId: mine, ...F })
      ).code
    ).toBe('ORDER_NOT_FOUND');
    expect(
      err(() =>
        earnPointsFromPurchase(f.db, { storeId: 's1', customerId: 'c1', orderId: '', ...F })
      ).code
    ).toBe('BAD_ID');
    expect(
      earnPointsFromPurchase(f.db, {
        storeId: 's1',
        customerId: 'c1',
        orderId: mine,
        featureEnabled: false,
      }).pointsEarned
    ).toBe(0);
    expect(f.txCount('1 = 1')).toBe(0);
  });

  it('settings change the rate and the expiry', () => {
    const f = fixture({ pointsPerMajorUnit: 3, expirationMonths: 0 });
    const o = f.order('s1', 'c1', 1050); // 10.5 EGP * 3 = 31.5 -> 31
    expect(
      earnPointsFromPurchase(f.db, { storeId: 's1', customerId: 'c1', orderId: o, ...F })
        .pointsEarned
    ).toBe(31);
    expect(
      f.one<{ expires_at: number | null }>(
        `SELECT expires_at FROM loyalty_transactions WHERE type = 'earn_purchase'`
      ).expires_at
    ).toBeNull();
  });
});

describe('loyalty: redeem', () => {
  it('burns exactly the quoted points with ONE conditional debit, records the order columns, replays safely', () => {
    const f = fixture();
    f.points('s1', 'c1', 1200);
    const o = f.order('s1', 'c1', 10000);
    const r = redeemPoints(f.db, {
      storeId: 's1',
      customerId: 'c1',
      orderId: o,
      points: 500,
      ...F,
      now: 7,
    });
    expect(r).toEqual({ pointsRedeemed: 500, discountFils: 500, newBalance: 700, replayed: false });
    expect(f.bal('s1', 'c1')).toMatchObject({ points: 700, total_redeemed: 500 });
    expect(
      f.one(`SELECT loyalty_points_redeemed p, loyalty_discount d FROM orders WHERE id = '${o}'`)
    ).toEqual({ p: 500, d: 500 });
    const again = redeemPoints(f.db, {
      storeId: 's1',
      customerId: 'c1',
      orderId: o,
      points: 500,
      ...F,
    });
    expect(again).toMatchObject({ replayed: true, pointsRedeemed: 500, newBalance: 700 });
    expect(f.bal('s1', 'c1').points).toBe(700);
    expect(f.txCount(`type = 'redeem_discount'`)).toBe(1);
  });

  it('points can never go negative: two orders racing for one balance, the second is refused and changes nothing', () => {
    const f = fixture({ maxRedeemPercentage: 100 });
    f.points('s1', 'c1', 600);
    const a = f.order('s1', 'c1', 100000);
    const b = f.order('s1', 'c1', 100000);
    redeemPoints(f.db, { storeId: 's1', customerId: 'c1', orderId: a, points: 500, ...F });
    const e = err(() =>
      redeemPoints(f.db, { storeId: 's1', customerId: 'c1', orderId: b, points: 500, ...F })
    );
    expect(e.code).toBe('INSUFFICIENT_POINTS');
    expect(f.bal('s1', 'c1')).toMatchObject({ points: 100, total_redeemed: 500 });
    expect(f.txCount(`order_id = '${b}'`)).toBe(0);
    expect(f.one(`SELECT loyalty_points_redeemed p FROM orders WHERE id = '${b}'`).p).toBeNull();
    // and the table itself cannot be driven negative by the guarded statement
    expect(
      f.db.all(
        `UPDATE loyalty_points SET points = points - 9999 WHERE store_id = 's1' AND customer_id = 'c1' AND points >= 9999 RETURNING points`,
        []
      )
    ).toHaveLength(0);
  });

  it('the debit statement itself is the gate: a balance drained between the read and the write is refused', () => {
    const f = fixture();
    f.points('s1', 'c1', 1000);
    const o = f.order('s1', 'c1', 10000);
    const racing = {
      ...f.db,
      all(sql: string, params: unknown[]) {
        if (sql.includes('UPDATE loyalty_points SET points = points - ?1'))
          f.x(`UPDATE loyalty_points SET points = 100 WHERE customer_id = 'c1'`); // a concurrent spend lands first
        return f.db.all(sql, params);
      },
    };
    const e = err(() =>
      redeemPoints(racing, { storeId: 's1', customerId: 'c1', orderId: o, points: 500, ...F })
    );
    expect(e.code).toBe('INSUFFICIENT_POINTS');
    expect(f.bal('s1', 'c1').points).toBe(1000); // the refused unit rolled back whole (incl. the simulated drain)
    expect(f.txCount(`order_id = '${o}'`)).toBe(0);
  });

  it('enforces the minimum, the percentage cap and the subtotal, and refuses hostile counts', () => {
    const f = fixture(); // min 500, max 50%
    f.points('s1', 'c1', 100000);
    const o = f.order('s1', 'c1', 10000); // cap = 5000 piastres = 5000 points at 1/point
    const redeem = (points: number, orderId = o) =>
      redeemPoints(f.db, { storeId: 's1', customerId: 'c1', orderId, points, ...F });
    expect(err(() => redeem(499)).code).toBe('MIN_POINTS_NOT_MET');
    expect(err(() => redeem(5001)).code).toBe('REDEMPTION_EXCEEDS_CAP');
    for (const bad of [0, -5, 1.5, NaN, Infinity, 1e12])
      expect(err(() => redeem(bad)).code).toBe('BAD_POINTS');
    expect(f.bal('s1', 'c1').points).toBe(100000);
    expect(redeem(5000).discountFils).toBe(5000);
  });

  it('a store with a pointsValue of 5 discounts 5 piastres per point', () => {
    const f = fixture({ pointsValue: 5, minRedeemPoints: 10 });
    f.points('s1', 'c1', 1000);
    const o = f.order('s1', 'c1', 10000); // 50% cap = 5000 -> 1000 points max
    expect(
      redeemPoints(f.db, { storeId: 's1', customerId: 'c1', orderId: o, points: 400, ...F })
    ).toMatchObject({ discountFils: 2000, newBalance: 600 });
  });

  it('is refused when loyalty is off, for no points row, another store or another customer', () => {
    const off = fixture({}, 0);
    off.points('s1', 'c1', 5000);
    const o1 = off.order('s1', 'c1', 10000);
    expect(
      err(() =>
        redeemPoints(off.db, { storeId: 's1', customerId: 'c1', orderId: o1, points: 500, ...F })
      ).code
    ).toBe('LOYALTY_DISABLED');
    const f = fixture();
    const o = f.order('s1', 'c1', 10000);
    expect(
      err(() =>
        redeemPoints(f.db, { storeId: 's1', customerId: 'c1', orderId: o, points: 500, ...F })
      ).code
    ).toBe('NO_POINTS');
    f.points('s1', 'c1', 5000);
    const foreign = f.order('s2', 'x1', 10000);
    expect(
      err(() =>
        redeemPoints(f.db, { storeId: 's1', customerId: 'c1', orderId: foreign, points: 500, ...F })
      ).code
    ).toBe('ORDER_NOT_FOUND');
    expect(
      err(() =>
        redeemPoints(f.db, { storeId: 's1', customerId: 'c2', orderId: o, points: 500, ...F })
      ).code
    ).toBe('ORDER_NOT_FOUND');
    expect(
      err(() =>
        redeemPoints(f.db, {
          storeId: 's1',
          customerId: 'c1',
          orderId: o,
          points: 500,
          featureEnabled: false,
        })
      ).code
    ).toBe('LOYALTY_DISABLED');
    expect(f.bal('s1', 'c1').points).toBe(5000);
  });
});

describe('loyalty: reversals', () => {
  it('reverses the FULL earn once (spent points become debt, #631), drops total_earned and the tier', () => {
    const f = fixture();
    const o = f.order('s1', 'c1', 100000); // 1000 pts
    earnPointsFromPurchase(f.db, { storeId: 's1', customerId: 'c1', orderId: o, ...F });
    expect(f.bal('s1', 'c1').tier).toBe('silver');
    // the customer spent 700 of them since
    f.x(`UPDATE loyalty_points SET points = 300, total_redeemed = 700 WHERE customer_id = 'c1'`);
    const r = reverseEarnedPointsFromOrder(f.db, { storeId: 's1', orderId: o });
    expect(r).toEqual({ pointsReversed: 1000, newBalance: -700, debt: 700, replayed: false });
    expect(f.bal('s1', 'c1')).toMatchObject({ points: -700, total_earned: 0, tier: 'bronze' });
    const again = reverseEarnedPointsFromOrder(f.db, { storeId: 's1', orderId: o });
    expect(again).toMatchObject({ pointsReversed: 0, replayed: true });
    expect(f.bal('s1', 'c1').points).toBe(-700);
    expect(f.txCount(`type = 'adjust' AND description LIKE 'refund-revoke:%'`)).toBe(1);
    expect(f.txCount(`type = 'tier_changed' AND description LIKE '%refund reverse%'`)).toBe(1);
  });

  it('re-credits the redeemed points once and unwinds total_redeemed', () => {
    const f = fixture();
    f.points('s1', 'c1', 1000);
    const o = f.order('s1', 'c1', 10000);
    redeemPoints(f.db, { storeId: 's1', customerId: 'c1', orderId: o, points: 600, ...F });
    expect(f.bal('s1', 'c1')).toMatchObject({ points: 400, total_redeemed: 600 });
    const r = reverseRedeemedPointsFromOrder(f.db, { storeId: 's1', orderId: o });
    expect(r).toEqual({ pointsRecredited: 600, newBalance: 1000, replayed: false });
    expect(reverseRedeemedPointsFromOrder(f.db, { storeId: 's1', orderId: o })).toMatchObject({
      pointsRecredited: 0,
      replayed: true,
    });
    expect(f.bal('s1', 'c1')).toMatchObject({ points: 1000, total_redeemed: 0 });
  });

  it('is a no-op (null) when nothing was earned or redeemed, and refuses another store order', () => {
    const f = fixture();
    const o = f.order('s1', 'c1', 5000);
    expect(reverseEarnedPointsFromOrder(f.db, { storeId: 's1', orderId: o })).toBeNull();
    expect(reverseRedeemedPointsFromOrder(f.db, { storeId: 's1', orderId: o })).toBeNull();
    const foreign = f.order('s2', 'x1', 5000);
    expect(
      err(() => reverseEarnedPointsFromOrder(f.db, { storeId: 's1', orderId: foreign })).code
    ).toBe('ORDER_NOT_FOUND');
  });
});

// -------------------------------------------------------------- differential vs the Postgres original
describe('loyalty: pure helpers equal the Postgres original', () => {
  async function original() {
    const mod = await import('../../../apps/api/src/services/loyalty.service');
    const L = mod.LoyaltyService as unknown as {
      calculateTier(t: number, s: unknown): string;
      getTierInfo(t: number, s: unknown): { multiplier: number };
    };
    return { computeRedemption: mod.computeRedemption, L, defaults: mod.DEFAULT_LOYALTY_SETTINGS };
  }
  const rnd = (seed: number) => () =>
    (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

  it('defaults are identical', async () => {
    const o = await original();
    expect(DEFAULT_LOYALTY_SETTINGS).toEqual(o.defaults);
  });

  it('computeRedemption agrees on 4000 random inputs (incl. odd pointsValue, caps, zero balances)', async () => {
    const o = await original();
    const r = rnd(7);
    for (let i = 0; i < 4000; i++) {
      const s = {
        ...DEFAULT_LOYALTY_SETTINGS,
        pointsValue: Math.floor(r() * 9),
        minRedeemPoints: Math.floor(r() * 800),
        maxRedeemPercentage: [0, 10, 33, 50, 100, 150][Math.floor(r() * 6)],
      };
      const req = Math.floor(r() * 20000) - 100;
      const sub = Math.floor(r() * 2_000_000) - 50;
      const avail = Math.floor(r() * 30000) - 10;
      expect(computeRedemption(s, req, sub, avail)).toEqual(
        o.computeRedemption(s, req, sub, avail)
      );
    }
  });

  it('tier + earn rounding agree on 4000 random (total, rate, totalEarned) triples', async () => {
    const o = await original();
    const r = rnd(11);
    for (let i = 0; i < 4000; i++) {
      const s = {
        ...DEFAULT_LOYALTY_SETTINGS,
        pointsPerMajorUnit: [0.5, 1, 1.5, 3, 7, 0.1][Math.floor(r() * 6)],
      };
      const total = Math.floor(r() * 5_000_000);
      const earned = Math.floor(r() * 30000);
      expect(calculateTier(earned, s)).toBe(o.L.calculateTier(earned, s));
      const expected = Math.floor(
        Math.floor(fromMinor(total) * s.pointsPerMajorUnit) * o.L.getTierInfo(earned, s).multiplier
      );
      expect(computeEarnPoints(total, s, earned)).toBe(expected);
    }
  });
});
