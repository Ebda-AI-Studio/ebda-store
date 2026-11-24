/**
 * INFRA-CF-1 PR D2b (Ruling CF-MONEY-1): every money operation moved to the StoreDO gives the same answer and leaves the same
 * rows on Postgres and on the DO. Each test is a SCENARIO driving the real service (`LoyaltyService`); it runs once on
 * Postgres (the unchanged Postgres code) and once with the DO money client over the real DO schema on SQLite (the real wire
 * codec, `answerMoneyOp`, `runMoneyOp`, the same seeded rows). The scrubbed traces (return values or error code + status, then
 * the money tables) must be equal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@ebda/database';
import {
  answerMoneyOp,
  decodeRpc,
  encodeRpc,
  ensureMoneyOpsSchema,
  createDoClient,
  createPrismaLite,
  ensureIdempotencySchema,
  runReads,
  runWrites,
} from '@ebda-src/repo';
import { LoyaltyService } from '../../apps/api/src/services/loyalty.service';
import { featureService } from '../../apps/api/src/services/feature.service';
import {
  makeMoneyClient,
  storeRepo,
  withRepo,
  type StoreReads,
  type StoreWrites,
} from '../../apps/api/src/lib/repo-factory';
import { AppError } from '../../apps/api/src/middleware/error-handler';
import { META, canon, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';

const sfx = Date.now().toString(36);
let STORE = '';
let userId = '';
const sqlite = openSqlite();

const SETTINGS = {
  pointsPerMajorUnit: 1,
  signupBonus: 100,
  referralBonus: 200,
  reviewBonus: 50,
  birthdayBonus: 500,
  tiers: {
    bronze: { minPoints: 0, multiplier: 1.0 },
    silver: { minPoints: 300, multiplier: 1.25 },
    gold: { minPoints: 5000, multiplier: 1.5 },
    platinum: { minPoints: 15000, multiplier: 2.0 },
  },
  pointsValue: 1,
  minRedeemPoints: 50,
  maxRedeemPercentage: 50,
  expirationMonths: 12,
};

function doRepo() {
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const sync = nodeSyncSql(sqlite);
  ensureMoneyOpsSchema(sync);
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId: STORE }) as never;
  const c = createDoClient(
    q => runReads(lite, q),
    m => runWrites(lite, sql, m)
  ) as never;
  const money = makeMoneyClient(async (op, args, key) => {
    const r = answerMoneyOp(sync, STORE, op, encodeRpc(args), key);
    if (!r.ok) throw new AppError(r.status, r.code, r.message);
    return decodeRpc(r.json);
  });
  return {
    storeId: STORE,
    backend: 'do' as const,
    db: c as StoreReads,
    writer: c as StoreWrites,
    money,
  };
}
const pgRepo = () => ({
  storeId: STORE,
  backend: 'pg' as const,
  db: prisma as never,
  writer: prisma as never,
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function scrub(v: unknown, names: Record<string, string>): unknown {
  let text = JSON.stringify(canon(v)) ?? 'null';
  for (const [id, name] of Object.entries(names)) text = text.split(id).join(`<${name}>`);
  return JSON.parse(text.replace(UUID, '<id>').replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"<date>"'));
}
const settle = async <T>(f: () => Promise<T>) =>
  f().then(
    v => ({ ok: v }),
    (e: { code?: string; statusCode?: number; message?: string }) => ({
      err: {
        code: e.code,
        status: e.statusCode,
        message: e.code ? undefined : String(e.message).slice(0, 160),
      },
    })
  );
const onPg = <T>(f: () => Promise<T>) => withRepo(pgRepo(), f);
const onDo = <T>(f: () => Promise<T>) => withRepo(doRepo(), f);

async function state(names: Record<string, string>) {
  const db = prisma as any; // reads below go through the CURRENT backend's client
  const { storeWriter } = await import('../../apps/api/src/lib/repo-factory');
  const w = (await storeWriter(STORE)) as any;
  void db;
  const pts = await w.loyaltyPoints.findMany({
    where: { storeId: STORE, customerId: { in: Object.keys(names) } },
    select: { customerId: true, points: true, totalEarned: true, totalRedeemed: true, tier: true },
  });
  const tx = await w.loyaltyTransaction.findMany({
    where: { storeId: STORE, customerId: { in: Object.keys(names) } },
    select: { customerId: true, orderId: true, type: true, points: true, description: true },
  });
  const key = (r: unknown) => JSON.stringify(r);
  return {
    points: pts.sort((a: any, b: any) => key(a).localeCompare(key(b))),
    tx: tx.sort((a: any, b: any) => key(a).localeCompare(key(b))),
  };
}

interface Fx {
  cust: string;
  o1: string;
  o2: string;
  names: Record<string, string>;
}
let n = 0;
async function fixtures(
  opts: { points?: number; totalEarned?: number; member?: boolean; preImport?: boolean } = {}
): Promise<Fx> {
  const k = `${sfx}${++n}`;
  const user = await prisma.user.create({
    data: {
      email: `loy-${k}@example.test`,
      passwordHash: 'x',
      firstName: 'L',
      lastName: 'Y',
      role: 'customer',
      // L-1: the admin award / list paths require a customer ACCOUNT of this store (SEC-CUSTOMER-SCOPE-1)
      ...(opts.member ? { storeId: STORE } : {}),
      status: 'active',
      emailVerified: true,
    },
  });
  const mkOrder = (no: string, total: number) =>
    prisma.order.create({
      data: {
        storeId: STORE,
        customerId: user.id,
        orderNumber: `LOY-${k}-${no}`,
        status: 'delivered',
        paymentStatus: 'paid',
        subtotal: total,
        tax: 0,
        shipping: 0,
        discount: 0,
        total,
        currency: 'EGP',
        shippingAddress: {},
        billingAddress: {},
      },
    });
  const o1 = await mkOrder('1', 25_000); // 250 EGP -> 250 points
  const o2 = await mkOrder('2', 20_000); // 200 EGP
  insertSqlite(sqlite, 'Order', [o1, o2] as never);
  if (opts.points !== undefined) {
    const row = await prisma.loyaltyPoints.create({
      data: {
        storeId: STORE,
        customerId: user.id,
        points: opts.points,
        totalEarned: opts.totalEarned ?? opts.points,
        tier: 'bronze',
      },
    });
    insertSqlite(sqlite, 'LoyaltyPoints', [row] as never);
  }
  // Both backends share ONE Postgres in this harness, so the PG run's ledger rows would be read by the DO run's lazy import as
  // "Postgres-only history" (in production a DO store's Postgres ledger is frozen at the switch). Customers that are not under
  // test for the import are flagged imported on the DO side so each backend starts from the same baseline.
  if (opts.preImport !== false)
    sqlite
      .prepare('INSERT OR REPLACE INTO do_flags (name, value) VALUES (?, 1)')
      .run(`loyalty_import:${user.id}`);
  return {
    cust: user.id,
    o1: o1.id,
    o2: o2.id,
    names: { [user.id]: 'cust', [o1.id]: 'o1', [o2.id]: 'o2' },
  };
}

/** Both backends run the scenario; each yields {result or error, resulting money tables}; they must be equal. */
async function bothBackends(fx: Fx, scenario: () => Promise<unknown>) {
  const run = async (on: typeof onPg) => {
    const out = await settle(() => on(scenario));
    return scrub({ out, state: await on(() => state(fx.names)) }, fx.names);
  };
  const pg = await run(onPg);
  const dobj = await run(onDo);
  return { pg: pg as any, dobj: dobj as any };
}
async function parity(fx: Fx, scenario: () => Promise<unknown>) {
  const { pg, dobj } = await bothBackends(fx, scenario);
  expect(dobj).toEqual(pg);
  return pg as any;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `d2b-${sfx}@example.test`,
      passwordHash: 'x',
      firstName: 'D',
      lastName: 'B',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  userId = user.id;
  STORE = (
    await prisma.store.create({
      data: {
        name: 'D2b',
        slug: `d2b-${sfx}`,
        ownerId: userId,
        status: 'active',
        loyaltyEnabled: true,
        loyaltySettings: SETTINGS as never,
      },
    })
  ).id;
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO store_config (store_id, loyalty_enabled, loyalty_settings) VALUES (?, 1, ?)`
    )
    .run(STORE, JSON.stringify(SETTINGS));
  // store-wide reads (members, stats): the test customers are flagged one by one in `fixtures`, so the store import is done
  sqlite
    .prepare("INSERT OR REPLACE INTO do_flags (name, value) VALUES ('loyalty_import_store', 1)")
    .run();
});
beforeEach(() => {
  // the vitest config resets mocks between tests: install the platform `loyalty` feature as ON for each one
  vi.spyOn(featureService, 'isFeatureEnabled').mockResolvedValue(true);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.loyaltyTransaction.deleteMany({ where: { storeId: STORE } });
  await prisma.loyaltyPoints.deleteMany({ where: { storeId: STORE } });
  await prisma.order.deleteMany({ where: { storeId: STORE } });
  await prisma.store.deleteMany({ where: { id: STORE } });
  await prisma.user.deleteMany({ where: { email: { contains: sfx } } });
  await prisma.$disconnect();
});

describe('loyalty (LoyaltyService)', () => {
  it('earnPointsFromPurchase: first earn creates the row, a replay and a second order behave the same', async () => {
    const fx = await fixtures();
    const t = await parity(fx, async () => ({
      first: await LoyaltyService.earnPointsFromPurchase(STORE, fx.cust, fx.o1, 25_000),
      replay: await LoyaltyService.earnPointsFromPurchase(STORE, fx.cust, fx.o1, 25_000),
      second: await LoyaltyService.earnPointsFromPurchase(STORE, fx.cust, fx.o2, 20_000),
    }));
    expect(t.out.ok.first.pointsEarned).toBe(250);
    expect(t.out.ok.replay.pointsEarned).toBe(0);
    // 250 + (200 * 1.0 bronze) = 450 total earned: crossed silver (300) on the second order -> a tier_changed row
    expect(t.state.tx.filter((r: any) => r.type === 'tier_changed').length).toBeGreaterThan(0);
  });

  it('earnPointsFromPurchase with the loyalty feature off earns nothing', async () => {
    const fx = await fixtures();
    const spy = vi.spyOn(featureService, 'isFeatureEnabled').mockResolvedValue(false);
    try {
      const t = await parity(fx, () =>
        LoyaltyService.earnPointsFromPurchase(STORE, fx.cust, fx.o1, 25_000)
      );
      expect(t.out.ok).toEqual({ pointsEarned: 0, newBalance: 0 });
      expect(t.state.tx).toEqual([]);
    } finally {
      spy.mockResolvedValue(true);
    }
  });

  it('reverseEarnedPointsFromOrder: full reversal, replay, an order that earned nothing, an unknown order', async () => {
    const fx = await fixtures();
    const t = await parity(fx, async () => {
      await LoyaltyService.earnPointsFromPurchase(STORE, fx.cust, fx.o1, 25_000);
      return {
        reversed: await LoyaltyService.reverseEarnedPointsFromOrder(STORE, fx.o1),
        replay: await LoyaltyService.reverseEarnedPointsFromOrder(STORE, fx.o1),
        neverEarned: await LoyaltyService.reverseEarnedPointsFromOrder(STORE, fx.o2),
        unknown: await LoyaltyService.reverseEarnedPointsFromOrder(
          STORE,
          '00000000-0000-4000-8000-000000000000'
        ),
      };
    });
    expect(t.out.ok.reversed.pointsReversed).toBe(250);
    expect(t.out.ok.replay.pointsReversed).toBe(0);
    expect(t.out.ok.neverEarned).toBeNull();
    expect(t.out.ok.unknown).toBeNull();
  });

  it('reverseEarnedPointsFromOrder: Postgres floors at the held balance; the DO takes back the full earn and leaves debt (Ruling MONEY-LOYALTY-LOTS-1, deliberate divergence)', async () => {
    const fx = await fixtures();
    const t = await bothBackends(fx, async () => {
      await LoyaltyService.earnPointsFromPurchase(STORE, fx.cust, fx.o1, 25_000);
      // the customer spends 200 of the 250 points (a redeem elsewhere; set directly on whichever backend is current)
      if ((await storeRepo(STORE)).backend === 'do')
        sqlite.prepare('UPDATE loyalty_points SET points = 50 WHERE customer_id = ?').run(fx.cust);
      else
        await prisma.loyaltyPoints.updateMany({
          where: { storeId: STORE, customerId: fx.cust },
          data: { points: 50 },
        });
      return LoyaltyService.reverseEarnedPointsFromOrder(STORE, fx.o1);
    });
    // Postgres LoyaltyService keeps the old floor (it cannot run in the Worker, NZ-D23).
    expect(t.pg.out.ok.pointsReversed).toBe(50);
    expect(t.pg.state.points[0].points).toBe(0);
    // The DO store takes back the FULL earn; points already spent leave a debt the next earn pays.
    expect(t.dobj.out.ok.pointsReversed).toBe(250);
    expect(t.dobj.state.points[0].points).toBe(-200);
  });

  it('reverseRedeemedPointsFromOrder: re-credits the spent points once, null when nothing was spent', async () => {
    const fx = await fixtures({ points: 400, totalEarned: 400 });
    // a redeem_discount row for o1 (points are stored negative), on both backends
    const redeem = await prisma.loyaltyTransaction.create({
      data: {
        storeId: STORE,
        customerId: fx.cust,
        orderId: fx.o1,
        type: 'redeem_discount',
        points: -120,
        description: 'Redeemed 120 points',
      },
    });
    insertSqlite(sqlite, 'LoyaltyTransaction', [redeem] as never);
    await prisma.loyaltyPoints.updateMany({
      where: { storeId: STORE, customerId: fx.cust },
      data: { totalRedeemed: 120 },
    });
    sqlite
      .prepare('UPDATE loyalty_points SET total_redeemed = 120 WHERE customer_id = ?')
      .run(fx.cust);
    const t = await parity(fx, async () => ({
      recredit: await LoyaltyService.reverseRedeemedPointsFromOrder(STORE, fx.o1),
      replay: await LoyaltyService.reverseRedeemedPointsFromOrder(STORE, fx.o1),
      nothingSpent: await LoyaltyService.reverseRedeemedPointsFromOrder(STORE, fx.o2),
    }));
    expect(t.out.ok.recredit.pointsRecredited).toBe(120);
    expect(t.out.ok.replay.pointsRecredited).toBe(0);
    expect(t.out.ok.nothingSpent).toBeNull();
  });
});

describe('loyalty admin reads + manual awards (L-1, Ruling FP-2)', () => {
  // both backends start these scenarios with no loyalty rows, so the store-wide list and stats are comparable
  beforeEach(async () => {
    await prisma.loyaltyTransaction.deleteMany({ where: { storeId: STORE } });
    await prisma.loyaltyPoints.deleteMany({ where: { storeId: STORE } });
    sqlite.prepare('DELETE FROM loyalty_transactions').run();
    sqlite.prepare('DELETE FROM loyalty_points').run();
  });

  it('awardBonusPoints then getCustomerPoints / history / members / stats read the same ledger on both backends', async () => {
    const big = await fixtures({ points: 900, totalEarned: 900, member: true });
    const small = await fixtures({ points: 120, totalEarned: 120, member: true });
    const t = await parity(small, async () => ({
      award: await LoyaltyService.awardBonusPoints(STORE, small.cust, 250, 'earn_manual', 'gift'),
      deduct: await LoyaltyService.awardBonusPoints(STORE, small.cust, -20, 'adjust', 'fix'),
      points: await LoyaltyService.getCustomerPoints(STORE, small.cust),
      history: await LoyaltyService.getTransactionHistory(STORE, small.cust),
      members: await LoyaltyService.listMembers(STORE, {}),
      silver: await LoyaltyService.listMembers(STORE, { tier: 'silver' }),
      stats: await LoyaltyService.getStats(STORE),
      storeLog: await LoyaltyService.listStoreTransactions(STORE, {
        page: 1,
        limit: 10,
        type: 'earn_manual',
      }),
    }));
    void big;
    expect(t.out.ok.award.newBalance).toBe(370);
    expect(t.out.ok.deduct.newBalance).toBe(350);
    expect(t.out.ok.members.members).toHaveLength(2);
    expect(t.out.ok.stats.totalMembers).toBe(2);
  });

  it('a manual award is spendable: award, then the order redeem sees the points', async () => {
    const fx = await fixtures({ member: true });
    const t = await parity(fx, async () => {
      await LoyaltyService.awardBonusPoints(STORE, fx.cust, 200, 'earn_manual', 'gift');
      return LoyaltyService.getCustomerPoints(STORE, fx.cust);
    });
    expect(t.out.ok.points).toBe(200);
  });

  it('awardBonusPoints refuses a user who is not this store customer, the same on both', async () => {
    const stranger = await fixtures(); // no storeId on the account
    const t = await parity(stranger, () =>
      LoyaltyService.awardBonusPoints(STORE, stranger.cust, 10, 'earn_manual', 'x')
    );
    expect(t.out.err.code).toBe('CUSTOMER_NOT_FOUND');
    expect(t.state.points).toEqual([]);
  });

  it('initializeCustomerPoints (signup bonus once) and awardReviewBonus (once per review / product) match', async () => {
    const fx = await fixtures({ member: true });
    const t = await parity(fx, async () => ({
      init: await LoyaltyService.initializeCustomerPoints(STORE, fx.cust, true),
      again: await settle(() => LoyaltyService.initializeCustomerPoints(STORE, fx.cust, true)),
      review: await LoyaltyService.awardReviewBonus(STORE, fx.cust, fx.o1, fx.o2),
      reviewAgain: await LoyaltyService.awardReviewBonus(STORE, fx.cust, fx.o1, fx.o2),
    }));
    expect(t.out.ok.init.points).toBe(100);
    expect(t.out.ok.review).toEqual({ awarded: true, points: 50 });
    expect(t.out.ok.reviewAgain).toEqual({ awarded: false, points: 0 });
  });

  it('FP-2: a member whose history exists only on Postgres keeps balance and bonuses after the store moves to the DO', async () => {
    const fx = await fixtures({ member: true, preImport: false }); // sqlite starts EMPTY for this customer: the pre-switch state
    await prisma.loyaltyPoints.create({
      data: { storeId: STORE, customerId: fx.cust, points: 175, totalEarned: 175, tier: 'bronze' },
    });
    const desc = 'Review bonus for product prod-1 (review rev-1)';
    for (const [type, points, description] of [
      ['earn_signup', 100, 'Welcome bonus for joining loyalty program'],
      ['earn_review', 50, desc],
      ['earn_manual', 25, 'gift'],
    ] as const)
      await prisma.loyaltyTransaction.create({
        data: { storeId: STORE, customerId: fx.cust, type, points, description },
      });

    const pg = await onPg(() => LoyaltyService.getCustomerPoints(STORE, fx.cust));
    const dobj = await onDo(async () => ({
      points: await LoyaltyService.getCustomerPoints(STORE, fx.cust), // lazy import happens here
      join: await settle(() => LoyaltyService.initializeCustomerPoints(STORE, fx.cust, true)),
      review: await LoyaltyService.awardReviewBonus(STORE, fx.cust, 'prod-1', 'rev-1'),
      migrate: await LoyaltyService.migrateLedgerToDo(STORE, { dryRun: false }),
      migrateAgain: await LoyaltyService.migrateLedgerToDo(STORE, { dryRun: false }),
      after: await LoyaltyService.getCustomerPoints(STORE, fx.cust),
    }));
    expect(dobj.points?.points).toBe(pg?.points); // 175 on both
    expect(dobj.points?.points).toBe(175);
    expect(dobj.join).toMatchObject({ err: { code: 'ALREADY_EXISTS' } });
    expect(dobj.review).toEqual({ awarded: false, points: 0 });
    expect(dobj.migrate.inserted).toBe(0); // everything was imported on the first touch
    expect(dobj.migrateAgain.inserted).toBe(0);
    expect(dobj.after?.points).toBe(175);
    expect(
      sqlite
        .prepare('SELECT count(*) AS n FROM loyalty_transactions WHERE customer_id = ?')
        .get(fx.cust)
    ).toEqual({ n: 3 });
  });

  it('a deduction larger than the balance is refused the same way on both backends', async () => {
    const fx = await fixtures({ points: 10, totalEarned: 10, member: true });
    const t = await parity(fx, () =>
      LoyaltyService.awardBonusPoints(STORE, fx.cust, -50, 'adjust', 'too much')
    );
    expect(t.out.err).toMatchObject({ code: 'INSUFFICIENT_POINTS', status: 409 });
    expect(t.state.points[0].points).toBe(10);
  });
});
