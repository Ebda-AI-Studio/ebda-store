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
async function fixtures(opts: { points?: number; totalEarned?: number } = {}): Promise<Fx> {
  const k = `${sfx}${++n}`;
  const user = await prisma.user.create({
    data: {
      email: `loy-${k}@example.test`,
      passwordHash: 'x',
      firstName: 'L',
      lastName: 'Y',
      role: 'customer',
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
  return {
    cust: user.id,
    o1: o1.id,
    o2: o2.id,
    names: { [user.id]: 'cust', [o1.id]: 'o1', [o2.id]: 'o2' },
  };
}

/** Both backends run the scenario; each yields {result or error, resulting money tables}; they must be equal. */
async function parity(fx: Fx, scenario: () => Promise<unknown>) {
  const run = async (on: typeof onPg) => {
    const out = await settle(() => on(scenario));
    return scrub({ out, state: await on(() => state(fx.names)) }, fx.names);
  };
  const pg = await run(onPg);
  const dobj = await run(onDo);
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
        loyaltySettings: SETTINGS as never,
      },
    })
  ).id;
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO store_config (store_id, loyalty_enabled, loyalty_settings) VALUES (?, 1, ?)`
    )
    .run(STORE, JSON.stringify(SETTINGS));
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

  it('reverseEarnedPointsFromOrder floors at the balance a customer still holds (spent points are not clawed negative)', async () => {
    const fx = await fixtures();
    const t = await parity(fx, async () => {
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
    expect(t.out.ok.pointsReversed).toBe(50);
    expect(t.state.points[0].points).toBe(0);
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
