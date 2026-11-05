// L-1 (Ruling FP-2): the admin / storefront loyalty reads and the manual award on the DO ledger (real DO schema, node:sqlite).
// The point of the split fix: an award lands where the DO redeem reads, and the members / stats / history show what was earned.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, runMoneyOp } from '../src/do/money-ops';
import { redeemPoints } from '../src/do/loyalty';
import { MoneyError } from '../src/do/sync-sql';

const S = 's1';
const SETTINGS = {
  minRedeemPoints: 50,
  maxRedeemPercentage: 100,
  tiers: {
    bronze: { minPoints: 0, multiplier: 1 },
    silver: { minPoints: 300, multiplier: 1.25 },
    gold: { minPoints: 5000, multiplier: 1.5 },
    platinum: { minPoints: 15000, multiplier: 2 },
  },
};

function rig(enabled = 1) {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  raw
    .prepare(
      `INSERT OR REPLACE INTO store_config (store_id, loyalty_enabled, loyalty_settings) VALUES (?, ?, ?)`
    )
    .run(S, enabled, JSON.stringify(SETTINGS));
  raw.exec(`
    INSERT INTO orders (id, store_id, customer_id, order_number, status, payment_status, subtotal, total, shipping_address, billing_address)
      VALUES ('o1', 's1', 'c1', 'N1', 'delivered', 'paid', 10000, 10000, '{}', '{}'),
             ('o2', 's1', 'c1', 'N2', 'pending', 'unpaid', 20000, 20000, '{}', '{}');
  `);
  const op = (name: string, args: Record<string, unknown>) => runMoneyOp(db, S, name, args) as any;
  const code = (name: string, args: Record<string, unknown>): string => {
    try {
      op(name, args);
    } catch (e) {
      return `${(e as MoneyError).code}/${(e as MoneyError).status}`;
    }
    return 'no error';
  };
  const q = (sql: string, ...p: unknown[]) => raw.prepare(sql).all(...(p as never[])) as any[];
  return { raw, db, op, code, q };
}
const feature = { featureEnabled: true };

describe('loyalty on the DO: manual award, members, stats, history', () => {
  it('an award is spendable by the DO redeem and the members list equals what was earned', () => {
    const r = rig();
    expect(r.op('loyaltyEarn', { customerId: 'c1', orderId: 'o1', ...feature })).toMatchObject({
      pointsEarned: 100,
    });
    expect(
      r.op('loyaltyAward', {
        customerId: 'c1',
        points: 50,
        type: 'earn_manual',
        description: 'gift',
        ...feature,
      })
    ).toEqual({ newBalance: 150 });

    const members = r.op('loyaltyMembers', {});
    expect(members.members).toHaveLength(1);
    expect(members.members[0]).toMatchObject({ customerId: 'c1', points: 150, totalEarned: 150 });
    expect(members.pagination).toMatchObject({ total: 1, page: 1 });

    // the redeem is the unchanged engine: it sees the awarded points (100 earned + 50 awarded = the 150 spent)
    const red = redeemPoints(r.db, {
      storeId: S,
      customerId: 'c1',
      orderId: 'o2',
      points: 150,
      featureEnabled: true,
    });
    expect(red).toMatchObject({ pointsRedeemed: 150, newBalance: 0, replayed: false });

    expect(r.op('loyaltyStats', {})).toEqual({
      totalMembers: 1,
      tierBreakdown: { bronze: 1, silver: 0, gold: 0, platinum: 0 },
      totalPointsIssued: 150,
      totalPointsRedeemed: 150,
      outstandingPoints: 0,
    });
  });

  it('history is newest first, carries the order number, and pages', () => {
    const r = rig();
    r.op('loyaltyEarn', { customerId: 'c1', orderId: 'o1', ...feature });
    r.op('loyaltyAward', { customerId: 'c1', points: 25, type: 'earn_manual', ...feature });
    const h = r.op('loyaltyHistory', { customerId: 'c1', limit: 1 });
    expect(h.transactions).toHaveLength(1);
    expect(h.pagination).toMatchObject({ total: 2, totalPages: 2, limit: 1 });
    const all = r.op('loyaltyHistory', { customerId: 'c1' });
    const earn = all.transactions.find((t: any) => t.type === 'earn_purchase');
    expect(earn.order).toEqual({ id: 'o1', orderNumber: 'N1' });
    const store = r.op('loyaltyStoreTransactions', { type: 'earn_manual' });
    expect(store.total).toBe(1);
    expect(store.transactions[0]).toMatchObject({ points: 25, customerId: 'c1' });
  });

  it('a negative award lowers the balance and counts as redeemed; tier follows earned points', () => {
    const r = rig();
    r.op('loyaltyAward', { customerId: 'c1', points: 400, type: 'earn_manual', ...feature });
    expect(r.op('loyaltyMembers', { tier: 'silver' }).members).toHaveLength(1);
    expect(
      r.op('loyaltyAward', { customerId: 'c1', points: -100, type: 'adjust', ...feature })
    ).toEqual({
      newBalance: 300,
    });
    expect(r.q('SELECT total_redeemed AS n FROM loyalty_points')[0].n).toBe(100);
  });

  it('refuses when the platform flag is off or the DO has no config row; zero and unknown types are refused', () => {
    const r = rig();
    expect(
      r.code('loyaltyAward', {
        customerId: 'c1',
        points: 10,
        type: 'earn_manual',
        featureEnabled: false,
      })
    ).toBe('LOYALTY_DISABLED/400');
    expect(
      r.code('loyaltyAward', { customerId: 'c1', points: 0, type: 'earn_manual', ...feature })
    ).toBe('BAD_POINTS/400');
    expect(
      r.code('loyaltyAward', { customerId: 'c1', points: 5, type: 'earn_purchase', ...feature })
    ).toBe('BAD_ARGS/400');
    r.raw.exec(`DELETE FROM store_config`);
    expect(
      r.code('loyaltyAward', { customerId: 'c1', points: 10, type: 'earn_manual', ...feature })
    ).toBe('LOYALTY_DISABLED/400');
    expect(r.op('loyaltyCustomerPoints', { customerId: 'c1', ...feature })).toBeNull();
  });

  it('customer points, init (signup bonus once) and review bonus (once per review and per product)', () => {
    const r = rig();
    expect(r.op('loyaltyCustomerPoints', { customerId: 'c1', ...feature })).toBeNull();
    const init = r.op('loyaltyInit', { customerId: 'c1', giveSignupBonus: true, ...feature });
    expect(init.row).toMatchObject({ customerId: 'c1', points: 100, totalEarned: 100 });
    expect(r.code('loyaltyInit', { customerId: 'c1', giveSignupBonus: true, ...feature })).toBe(
      'ALREADY_EXISTS/400'
    );
    expect(r.op('loyaltyCustomerPoints', { customerId: 'c1', ...feature }).row.points).toBe(100);
    const rev = { customerId: 'c1', productId: 'p1', reviewId: 'r1', ...feature };
    expect(r.op('loyaltyReviewBonus', rev)).toEqual({ awarded: true, points: 50 });
    expect(r.op('loyaltyReviewBonus', rev)).toEqual({ awarded: false, points: 0 });
    expect(r.op('loyaltyReviewBonus', { ...rev, reviewId: 'r2' })).toEqual({
      awarded: false,
      points: 0,
    });
    expect(r.op('loyaltyReviewBonus', { ...rev, productId: 'p2', reviewId: 'r3' }).awarded).toBe(
      true
    );
  });

  it('the review bonus is off when the store switch is off', () => {
    const r = rig(0);
    expect(
      r.op('loyaltyReviewBonus', { customerId: 'c1', productId: 'p1', reviewId: 'r1', ...feature })
    ).toEqual({
      awarded: false,
      points: 0,
    });
  });

  it('import (FP-2 migration) applies each Postgres-only row once, keyed by its transaction id', () => {
    const r = rig();
    const rows = [
      { id: 't-1', type: 'earn_manual', points: 120, description: 'pg award', createdAt: 1000 },
      { id: 't-2', type: 'adjust', points: -20, description: 'pg deduct', createdAt: 2000 },
      { id: 't-3', type: 'earn_purchase', points: 40, orderId: 'missing-order', createdAt: 3000 },
    ];
    expect(r.op('loyaltyImport', { customerId: 'c1', rows })).toEqual({
      inserted: 3,
      skipped: 0,
      newBalance: 140,
    });
    expect(r.op('loyaltyImport', { customerId: 'c1', rows })).toEqual({
      inserted: 0,
      skipped: 3,
      newBalance: 140,
    });
    const lp = r.q('SELECT points, total_earned, total_redeemed, tier FROM loyalty_points')[0];
    expect(lp).toMatchObject({
      points: 140,
      total_earned: 160,
      total_redeemed: 20,
      tier: 'bronze',
    });
    // an order the DO does not hold is stored as NULL (never a dangling reference)
    expect(
      r.q(`SELECT order_id FROM loyalty_transactions WHERE id = 't-3'`)[0].order_id
    ).toBeNull();
  });

  it('import skips a ledger fact the DO already holds under another id (a cutover that regenerated ids)', () => {
    const r = rig();
    r.op('loyaltyImport', {
      customerId: 'c1',
      rows: [{ id: 'pg-1', type: 'earn_manual', points: 70, createdAt: 5000 }],
    });
    expect(
      r.op('loyaltyImport', {
        customerId: 'c1',
        rows: [{ id: 'other-id', type: 'earn_manual', points: 70, createdAt: 5000 }],
      })
    ).toMatchObject({ inserted: 0, skipped: 1, newBalance: 70 });
  });

  it('FP-2: a PG member with a signup bonus is not granted it again after the switch, in either order', () => {
    const r = rig();
    const pgSignup = { id: 'pg-s', type: 'earn_signup', points: 100, createdAt: 1000 };
    r.op('loyaltyImport', { customerId: 'c1', rows: [pgSignup], markDone: true });
    expect(r.op('loyaltyImportState', { customerId: 'c1' })).toEqual({ done: true });
    expect(r.op('loyaltyCustomerPoints', { customerId: 'c1', ...feature }).row.points).toBe(100);
    expect(r.code('loyaltyInit', { customerId: 'c1', giveSignupBonus: true, ...feature })).toBe(
      'ALREADY_EXISTS/400'
    );
    expect(r.op('loyaltyImport', { customerId: 'c1', rows: [pgSignup] })).toMatchObject({
      inserted: 0,
      newBalance: 100,
    });
    // the reverse order: the DO granted the bonus first, the PG row (other id, other time) must not add a second one
    const r2 = rig();
    r2.op('loyaltyInit', { customerId: 'c1', giveSignupBonus: true, ...feature });
    expect(
      r2.op('loyaltyImport', { customerId: 'c1', rows: [{ ...pgSignup, createdAt: 9 }] })
    ).toMatchObject({ inserted: 0, skipped: 1, newBalance: 100 });
  });

  it('FP-2: a PG review bonus is not granted again, and an imported one is not duplicated by the DO', () => {
    const r = rig();
    const desc = 'Review bonus for product p1 (review r1)';
    r.op('loyaltyImport', {
      customerId: 'c1',
      rows: [{ id: 'pg-r', type: 'earn_review', points: 50, description: desc, createdAt: 1000 }],
    });
    expect(
      r.op('loyaltyReviewBonus', { customerId: 'c1', productId: 'p1', reviewId: 'r1', ...feature })
    ).toEqual({ awarded: false, points: 0 });
    const r2 = rig();
    r2.op('loyaltyReviewBonus', { customerId: 'c1', productId: 'p1', reviewId: 'r1', ...feature });
    expect(
      r2.op('loyaltyImport', {
        customerId: 'c1',
        rows: [{ id: 'pg-r', type: 'earn_review', points: 50, description: desc, createdAt: 5 }],
      })
    ).toMatchObject({ inserted: 0, newBalance: 50 });
  });

  it('FP-2: a manual award in PG history is imported once; twice changes nothing', () => {
    const r = rig();
    const rows = [
      { id: 'pg-m', type: 'earn_manual', points: 40, description: 'gift', createdAt: 1000 },
    ];
    expect(r.op('loyaltyImport', { customerId: 'c1', rows })).toMatchObject({
      inserted: 1,
      newBalance: 40,
    });
    expect(r.op('loyaltyImport', { customerId: 'c1', rows })).toMatchObject({
      inserted: 0,
      newBalance: 40,
    });
    expect(r.op('loyaltyCustomerPoints', { customerId: 'c1', ...feature }).row.points).toBe(40);
  });

  it('one row the DO already holds does not abort the batch (earn_purchase under another id and time)', () => {
    const r = rig();
    r.op('loyaltyEarn', { customerId: 'c1', orderId: 'o1', ...feature });
    const out = r.op('loyaltyImport', {
      customerId: 'c1',
      rows: [
        { id: 'pg-e', orderId: 'o1', type: 'earn_purchase', points: 100, createdAt: 77 },
        { id: 'pg-x', type: 'earn_manual', points: 15, createdAt: 78 },
        {
          id: 'pg-t',
          orderId: 'o1',
          type: 'adjust',
          points: -100,
          description: 'refund-revoke:abc',
          createdAt: 79,
        },
      ],
    });
    expect(out).toMatchObject({
      inserted: 2,
      skipped: 1,
      newBalance: 15,
    });
    // the replay of the tagged reversal is skipped by (order, description)
    expect(
      r.op('loyaltyImport', {
        customerId: 'c1',
        rows: [
          {
            id: 'pg-t2',
            orderId: 'o1',
            type: 'adjust',
            points: -100,
            description: 'refund-revoke:abc',
            createdAt: 1,
          },
        ],
      })
    ).toMatchObject({ inserted: 0, skipped: 1 });
  });

  it('import state and the store flag', () => {
    const r = rig();
    expect(r.op('loyaltyImportState', {})).toEqual({ done: false });
    r.op('loyaltyMarkImported', {});
    expect(r.op('loyaltyImportState', {})).toEqual({ done: true });
    expect(r.op('loyaltyImportState', { customerId: 'c9' })).toEqual({ done: false });
  });

  it('a deduction below zero is refused (409) and changes nothing', () => {
    const r = rig();
    r.op('loyaltyAward', { customerId: 'c1', points: 30, type: 'earn_manual', ...feature });
    expect(
      r.code('loyaltyAward', { customerId: 'c1', points: -31, type: 'adjust', ...feature })
    ).toBe('INSUFFICIENT_POINTS/409');
    expect(r.q('SELECT points FROM loyalty_points')[0].points).toBe(30);
    expect(r.q('SELECT count(*) AS n FROM loyalty_transactions')[0].n).toBe(1);
    expect(
      r.op('loyaltyAward', { customerId: 'c1', points: -30, type: 'adjust', ...feature })
    ).toEqual({
      newBalance: 0,
    });
    // a first-ever deduction (no row yet) is refused and leaves no empty row behind
    const r2 = rig();
    expect(
      r2.code('loyaltyAward', { customerId: 'c1', points: -1, type: 'adjust', ...feature })
    ).toBe('INSUFFICIENT_POINTS/409');
    expect(r2.q('SELECT count(*) AS n FROM loyalty_points')[0].n).toBe(0);
  });

  it('a READ never makes a member: an import with no rows creates no points row and a non-member stays joinable', () => {
    const r = rig();
    expect(r.op('loyaltyImport', { customerId: 'c1', rows: [], markDone: true })).toMatchObject({
      inserted: 0,
      newBalance: 0,
    });
    expect(r.q('SELECT count(*) AS n FROM loyalty_points')[0].n).toBe(0);
    expect(r.op('loyaltyImportState', { customerId: 'c1' })).toEqual({ done: true });
    expect(r.op('loyaltyCustomerPoints', { customerId: 'c1', ...feature })).toBeNull();
    // join still grants the signup bonus, once
    expect(
      r.op('loyaltyInit', { customerId: 'c1', giveSignupBonus: true, ...feature }).row.points
    ).toBe(100);
    expect(r.code('loyaltyInit', { customerId: 'c1', giveSignupBonus: true, ...feature })).toBe(
      'ALREADY_EXISTS/400'
    );
  });

  it('a duplicate-only import (nothing inserted) creates no points row either', () => {
    const r = rig();
    r.raw.exec(
      `INSERT INTO loyalty_transactions (id, store_id, customer_id, type, points, created_at) VALUES ('x1','s1','c1','earn_manual',5,1000)`
    );
    const out = r.op('loyaltyImport', {
      customerId: 'c1',
      rows: [{ id: 'x1', type: 'earn_manual', points: 5, createdAt: 1000 }],
    });
    expect(out).toMatchObject({ inserted: 0, skipped: 1 });
    expect(r.q('SELECT count(*) AS n FROM loyalty_points')[0].n).toBe(0);
  });

  it('no config row: import and mark create and flag nothing', () => {
    const none = rig();
    none.raw.exec('DELETE FROM store_config');
    const rows = [{ id: 'p1', type: 'earn_manual', points: 5, createdAt: 1 }];
    expect(none.op('loyaltyImport', { customerId: 'c1', rows, markDone: true })).toMatchObject({
      inserted: 0,
      disabled: true,
    });
    expect(none.op('loyaltyMarkImported', { customerId: 'c1' })).toEqual({ done: false });
    expect(none.q('SELECT count(*) AS n FROM loyalty_points')[0].n).toBe(0);
    expect(none.q('SELECT count(*) AS n FROM loyalty_transactions')[0].n).toBe(0);
    expect(
      none.q('SELECT count(*) AS n FROM do_flags WHERE name LIKE ?', 'loyalty_import%')[0].n
    ).toBe(0);
  });

  it('config row with loyalty switched OFF: history is imported and marked (data, not enablement); an award after it lands on it; re-enable has no duplicate signup', () => {
    const off = rig(0);
    const hist = [
      { id: 'pg-s', type: 'earn_signup', points: 100, createdAt: 1000 },
      { id: 'pg-m', type: 'earn_manual', points: 40, description: 'gift', createdAt: 2000 },
    ];
    expect(off.op('loyaltyImport', { customerId: 'c1', rows: hist, markDone: true })).toMatchObject(
      {
        inserted: 2,
        newBalance: 140,
      }
    );
    expect(off.op('loyaltyImportState', { customerId: 'c1' })).toEqual({ done: true });
    // an owner award while disabled writes after the import, never before it
    expect(
      off.op('loyaltyAward', { customerId: 'c1', points: 10, type: 'earn_manual', ...feature })
    ).toEqual({
      newBalance: 150,
    });
    // the merchant switches loyalty back on
    off.raw.exec('UPDATE store_config SET loyalty_enabled = 1');
    expect(off.op('loyaltyCustomerPoints', { customerId: 'c1', ...feature }).row.points).toBe(150);
    expect(off.code('loyaltyInit', { customerId: 'c1', giveSignupBonus: true, ...feature })).toBe(
      'ALREADY_EXISTS/400'
    );
    expect(off.op('loyaltyImport', { customerId: 'c1', rows: hist })).toMatchObject({
      inserted: 0,
      newBalance: 150,
    });
  });
});

describe('loyalty automation on the DO (Ruling NZ-PG-7): point expiry and birthday bonus', () => {
  const NOW = Date.now();
  const seed = (r: ReturnType<typeof rig>) => {
    r.raw.exec(`
      INSERT INTO loyalty_points (id, store_id, customer_id, points, total_earned, total_redeemed, tier, created_at, updated_at)
        VALUES ('lp1','s1','c1',80,200,120,'bronze',1,1), ('lp2','s1','c2',500,500,0,'bronze',1,1);
      INSERT INTO loyalty_transactions (id, store_id, customer_id, type, points, expires_at, created_at)
        VALUES ('t1','s1','c1','earn_manual',60,${NOW - 1000},1), ('t2','s1','c1','earn_manual',60,${NOW - 500},1),
               ('t3','s1','c2','earn_manual',90,${NOW + 86400000},1), ('t4','s1','c3','earn_manual',10,${NOW - 1000},1);
    `);
  };

  it('expires the lapsed earn rows once: deducts (floored at the balance), writes one expire row, clears expires_at, a rerun is a no-op', () => {
    const r = rig();
    seed(r);
    const first = r.op('loyaltyExpire', {});
    expect(first).toMatchObject({ members: 1, expired: 80, more: false });
    expect(
      r.q("SELECT points, total_redeemed FROM loyalty_points WHERE customer_id='c1'")[0]
    ).toEqual({
      points: 0,
      total_redeemed: 200,
    });
    expect(r.q("SELECT points, description FROM loyalty_transactions WHERE type='expire'")).toEqual(
      [{ points: -80, description: '80 points expired' }]
    );
    // c3 has no balance row (skipped like Postgres), c2's row has not lapsed
    expect(
      r
        .q('SELECT id FROM loyalty_transactions WHERE expires_at IS NOT NULL ORDER BY id')
        .map(x => x.id)
    ).toEqual(['t3', 't4']);
    expect(r.op('loyaltyExpire', {})).toMatchObject({ members: 0, expired: 0 });
  });

  it('pages with a cursor', () => {
    const r = rig();
    seed(r);
    const p1 = r.op('loyaltyExpire', { limit: 1 });
    expect(p1.more).toBe(true);
    const p2 = r.op('loyaltyExpire', { limit: 1, after: p1.last });
    expect(p2.last).not.toBe(p1.last);
  });

  it('awards the birthday bonus to members born today, once a year, only when loyalty is on', () => {
    const r = rig();
    const dob = Date.UTC(1990, 10, 5);
    r.raw.exec(`
      CREATE TABLE IF NOT EXISTS _cauth_users (id TEXT PRIMARY KEY, date_of_birth INTEGER);
      INSERT INTO _cauth_users VALUES ('c1', ${dob}), ('c2', ${Date.UTC(1990, 0, 2)});
      INSERT INTO loyalty_points (id, store_id, customer_id, points, total_earned, total_redeemed, tier, created_at, updated_at)
        VALUES ('lp1','s1','c1',10,10,0,'bronze',1,1), ('lp2','s1','c2',10,10,0,'bronze',1,1);
    `);
    const args = { month: 11, day: 5, yearStart: Date.UTC(2026, 0, 1), ...feature };
    const out = r.op('loyaltyBirthdays', args);
    expect(out.awarded).toBe(1);
    expect(
      r.q("SELECT customer_id, type FROM loyalty_transactions WHERE type='earn_birthday'")
    ).toEqual([{ customer_id: 'c1', type: 'earn_birthday' }]);
    expect(r.op('loyaltyBirthdays', args).awarded).toBe(0); // already awarded this year
    expect(r.op('loyaltyBirthdays', { ...args, featureEnabled: false }).awarded).toBe(0);
  });
});
