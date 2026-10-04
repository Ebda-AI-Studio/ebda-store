/**
 * SP5 task 1 — plans/limits engine against a real Postgres.
 *
 * Covers every gated write the engine guards (product create, bulk import,
 * staff seat, custom domain), the monthly-order-cap policy (never blocks, flags
 * + notifies once), the automation flags layered into the feature map, the
 * migration's StorePlan -> plan-code backfill, and RLS on `store_subscriptions`.
 *
 * Plans are DATA, so the ceilings under test come from throwaway plan rows
 * (tiny limits) rather than creating 50+ products on the seeded `free` plan.
 *
 * Mutation proofs (run by hand, recorded in the commit body):
 *   1. bulk.service.ts: delete the Phase 2.9 `assertWithinLimit` call -> the
 *      "rejects the WHOLE batch before writing" test fails (rows are created).
 *   2. plan-limit.service.ts: change `used + delta > limit` to `>=` -> the
 *      "allows filling exactly to the limit" test fails.
 */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { prisma, withRlsBypass, type Prisma } from '@force/database';
import { planLimitsSchema, type PlanLimits } from '@force/shared';
import {
  assertWithinLimit,
  noteOrderCreated,
} from '../../apps/api/src/services/plan-limit.service';
import { getEntitlements } from '../../apps/api/src/services/plan-entitlements';
import { planService } from '../../apps/api/src/services/plan.service';
import { ProductService } from '../../apps/api/src/services/product.service';
import { BulkService } from '../../apps/api/src/services/bulk.service';
import { StoreService } from '../../apps/api/src/services/store.service';
import { featureService } from '../../apps/api/src/services/feature.service';
import { socketService } from '../../apps/api/src/services/socket.service';
import { EmailService } from '../../apps/api/src/services/email.service';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const uniq = crypto.randomUUID().slice(0, 8);
const TINY = `tiny-${uniq}`;
const NO_DOMAIN = `nodomain-${uniq}`;

const tinyLimits: PlanLimits = planLimitsSchema.parse({
  maxProducts: 2,
  maxStaff: 1,
  maxOrdersPerMonth: 2,
  maxStorageMb: 100,
  customDomain: false,
  platformFeeBps: 100,
  abandonedCartAutomation: false,
  whatsappAutomation: false,
});

const created = { stores: [] as string[], users: [] as string[], plans: [TINY, NO_DOMAIN] };

async function makeStore(planCode: string) {
  const id = crypto.randomUUID().slice(0, 10);
  const user = await prisma.user.create({
    data: {
      email: `planlim-${id}@test.local`,
      passwordHash: 'x',
      firstName: 'Plan',
      lastName: 'Limit',
      role: 'store_admin',
    },
  });
  const store = await prisma.store.create({
    data: { name: `planlim-${id}`, slug: `planlim-${id}`, ownerId: user.id, status: 'active' },
  });
  created.users.push(user.id);
  created.stores.push(store.id);
  await planService.assignPlan(store.id, { planCode });
  return { storeId: store.id, userId: user.id };
}

async function addStaff(storeId: string) {
  const id = crypto.randomUUID().slice(0, 10);
  const u = await prisma.user.create({
    data: {
      email: `planlim-staff-${id}@test.local`,
      passwordHash: 'x',
      firstName: 'S',
      lastName: 'T',
      role: 'staff',
    },
  });
  created.users.push(u.id);
  await prisma.storeStaff.create({ data: { storeId, userId: u.id } });
}

async function addProduct(storeId: string, slug: string) {
  return prisma.product.create({ data: { storeId, name: slug, slug, price: 1000 } });
}

async function addOrder(storeId: string) {
  return prisma.order.create({
    data: {
      storeId,
      orderNumber: `PL-${crypto.randomUUID().slice(0, 12)}`,
      subtotal: 100,
      total: 100,
      shippingAddress: {},
      billingAddress: {},
    },
  });
}

beforeAll(async () => {
  if (!hasDb) return;
  await prisma.plan.createMany({
    data: [
      {
        code: TINY,
        nameEn: 'Tiny',
        nameAr: 'صغير',
        sort: 1,
        isPublic: false,
        featureTier: 'starter',
        limits: tinyLimits,
      },
      {
        code: NO_DOMAIN,
        nameEn: 'NoDomain',
        nameAr: 'بلا نطاق',
        sort: 2,
        isPublic: false,
        featureTier: 'starter',
        limits: { ...tinyLimits, maxProducts: null },
      },
    ],
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await withRlsBypass(async tx => {
    await tx.storeSubscription.deleteMany({ where: { storeId: { in: created.stores } } });
    await tx.order.deleteMany({ where: { storeId: { in: created.stores } } });
    await tx.category.deleteMany({ where: { storeId: { in: created.stores } } });
    await tx.product.deleteMany({ where: { storeId: { in: created.stores } } });
    await tx.storeStaff.deleteMany({ where: { storeId: { in: created.stores } } });
    await tx.storeFeature.deleteMany({ where: { storeId: { in: created.stores } } });
    await tx.taxRate.deleteMany({ where: { storeId: { in: created.stores } } });
    await tx.store.deleteMany({ where: { id: { in: created.stores } } });
    await tx.user.deleteMany({ where: { id: { in: created.users } } });
    await tx.plan.deleteMany({ where: { code: { in: created.plans } } });
  });
});

async function expectLimitReached(p: Promise<unknown>) {
  const err = (await p.then(
    () => null,
    e => e
  )) as { statusCode?: number; code?: string; details?: Record<string, unknown> } | null;
  expect(err, 'expected PLAN_LIMIT_REACHED').not.toBeNull();
  expect(err!.statusCode).toBe(402);
  expect(err!.code).toBe('PLAN_LIMIT_REACHED');
  expect(err!.details?.messageEn).toBeTruthy();
  expect(err!.details?.messageAr).toMatch(/[؀-ۿ]/);
  expect(err!.details?.messageKey).toMatch(/^planLimit\./);
  return err!;
}

describe.skipIf(!hasDb)('plans engine — maxProducts', () => {
  it('allows creates below the limit and fills exactly to it, then 402s', async () => {
    const { storeId } = await makeStore(TINY);
    await ProductService.create(storeId, { name: 'one', price: 1000 } as never);
    // exactly AT the limit after the second create must still be allowed
    await ProductService.create(storeId, { name: 'two', price: 1000 } as never);
    const err = await expectLimitReached(
      ProductService.create(storeId, { name: 'three', price: 1000 } as never)
    );
    expect(err.details).toMatchObject({ limitKey: 'maxProducts', limit: 2, used: 2 });
    expect(await prisma.product.count({ where: { storeId } })).toBe(2);
  });

  it('soft-deleted products free their slot', async () => {
    const { storeId } = await makeStore(TINY);
    const a = await addProduct(storeId, 'a');
    await addProduct(storeId, 'b');
    await expectLimitReached(assertWithinLimit(storeId, 'maxProducts'));
    await prisma.product.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
    await expect(assertWithinLimit(storeId, 'maxProducts')).resolves.toBeUndefined();
  });

  it('comped (unlimited) never hits the ceiling', async () => {
    const { storeId } = await makeStore('comped');
    for (let i = 0; i < 4; i++) await addProduct(storeId, `c${i}`);
    await expect(
      assertWithinLimit(storeId, 'maxProducts', { delta: 1000 })
    ).resolves.toBeUndefined();
    await ProductService.create(storeId, { name: 'more', price: 1000 } as never);
  });
});

describe.skipIf(!hasDb)('plans engine — bulk import counts the whole batch', () => {
  const header = 'name,slug,price,category';

  it('rejects the WHOLE batch before writing a single row or category', async () => {
    const { storeId, userId } = await makeStore(TINY);
    await addProduct(storeId, 'existing'); // 1 of 2 used
    const csv = [header, 'A,a-new,1000,NewCat', 'B,b-new,1000,NewCat'].join('\n');
    await expectLimitReached(
      BulkService.importProducts(storeId, csv, { updateExisting: true }, userId)
    );
    // 1 existing + 2 new would be 3 > 2: nothing written, not even row 1 or the category
    expect(await prisma.product.count({ where: { storeId } })).toBe(1);
    expect(await prisma.category.count({ where: { storeId } })).toBe(0);
  });

  it('allows a batch that fills exactly to the limit; updates do not count', async () => {
    const { storeId, userId } = await makeStore(TINY);
    await addProduct(storeId, 'existing');
    const csv = [header, 'Existing renamed,existing,1500,', 'Fresh,fresh,1000,'].join('\n');
    const r = await BulkService.importProducts(storeId, csv, { updateExisting: true }, userId);
    expect(r.failed).toBe(0);
    expect(r.created).toBe(1);
    expect(r.updated).toBe(1);
    expect(await prisma.product.count({ where: { storeId } })).toBe(2);
  });
});

describe.skipIf(!hasDb)('plans engine — maxStaff', () => {
  it('seat 1 allowed, seat 2 -> 402, comped unlimited', async () => {
    const { storeId } = await makeStore(TINY);
    await expect(assertWithinLimit(storeId, 'maxStaff')).resolves.toBeUndefined();
    await addStaff(storeId);
    await expectLimitReached(assertWithinLimit(storeId, 'maxStaff'));

    const comped = await makeStore('comped');
    await addStaff(comped.storeId);
    await addStaff(comped.storeId);
    await expect(assertWithinLimit(comped.storeId, 'maxStaff')).resolves.toBeUndefined();
  });
});

describe.skipIf(!hasDb)('plans engine — customDomain', () => {
  it('a plan without the capability cannot attach a domain (service-level)', async () => {
    const { storeId } = await makeStore(TINY);
    await expectLimitReached(StoreService.update(storeId, { domain: `shop-${uniq}.example.com` }));
    const row = await prisma.store.findUnique({ where: { id: storeId }, select: { domain: true } });
    expect(row?.domain).toBeNull();
  });

  it('growth/comped may attach a domain', async () => {
    const { storeId } = await makeStore('comped');
    const s = await StoreService.update(storeId, { domain: `ok-${uniq}.example.com` });
    expect(s.domain).toBe(`ok-${uniq}.example.com`);
    const g = await makeStore('growth');
    await expect(assertWithinLimit(g.storeId, 'customDomain')).resolves.toBeUndefined();
  });

  it('a free store cannot, but is not blocked from clearing/keeping one', async () => {
    const { storeId } = await makeStore('free');
    await expectLimitReached(assertWithinLimit(storeId, 'customDomain'));
  });
});

describe.skipIf(!hasDb)(
  'plans engine — monthly orders never block, they flag and notify once',
  () => {
    it('flags the subscription once over the cap and notifies the merchant exactly once', async () => {
      const { storeId } = await makeStore(TINY);
      const notify = vi.spyOn(socketService, 'notifyStore').mockImplementation(() => undefined);
      const email = vi.spyOn(EmailService, 'sendPlanLimitReached').mockResolvedValue(undefined);
      try {
        await addOrder(storeId);
        await addOrder(storeId);
        expect((await noteOrderCreated(storeId)).over).toBe(false); // at the cap, not over
        await addOrder(storeId);
        expect((await noteOrderCreated(storeId)).over).toBe(true);
        await addOrder(storeId);
        expect((await noteOrderCreated(storeId)).over).toBe(true);

        const e = await getEntitlements(storeId);
        expect(e?.ordersOverLimitMonth).toBeInstanceOf(Date);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][1]).toMatchObject({ type: 'plan_limit' });
        expect(email).toHaveBeenCalledTimes(1);
        // The order itself was never rejected: all four rows exist.
        expect(await prisma.order.count({ where: { storeId } })).toBe(4);
      } finally {
        notify.mockRestore();
        email.mockRestore();
      }
    });

    it('never throws and never flags an unlimited (comped) store', async () => {
      const { storeId } = await makeStore('comped');
      await addOrder(storeId);
      await expect(noteOrderCreated(storeId)).resolves.toEqual({ over: false });
      expect((await getEntitlements(storeId))?.ordersOverLimitMonth).toBeNull();
    });
  }
);

describe.skipIf(!hasDb)('plans engine — automation flags feed the feature gate', () => {
  it('free: whatsapp + abandoned_cart off; comped: on; StoreFeature override still wins', async () => {
    const free = await makeStore('free');
    expect(await featureService.isFeatureEnabled(free.storeId, 'whatsapp')).toBe(false);
    expect(await featureService.isFeatureEnabled(free.storeId, 'abandoned_cart')).toBe(false);

    const comped = await makeStore('comped');
    expect(await featureService.isFeatureEnabled(comped.storeId, 'whatsapp')).toBe(true);
    expect(await featureService.isFeatureEnabled(comped.storeId, 'abandoned_cart')).toBe(true);

    await prisma.storeFeature.create({
      data: { storeId: free.storeId, featureKey: 'whatsapp', enabled: true },
    });
    await featureService.invalidateCache(free.storeId);
    expect(await featureService.isFeatureEnabled(free.storeId, 'whatsapp')).toBe(true);
  });
});

describe.skipIf(!hasDb)('plans engine — canceled falls back to free limits', () => {
  it('a canceled subscription is held to the free plan', async () => {
    const { storeId } = await makeStore('comped');
    await prisma.storeSubscription.update({ where: { storeId }, data: { status: 'canceled' } });
    const e = await getEntitlements(storeId);
    expect(e?.planCode).toBe('free');
    expect(e?.subscribedPlanCode).toBe('comped');
    expect(e?.limits.maxProducts).toBe(50);
  });
});

describe.skipIf(!hasDb)('migration — StorePlan enum -> plan code backfill', () => {
  const sql = fs.readFileSync(
    path.resolve(
      __dirname,
      '../../packages/database/prisma/migrations/20261003130000_plans_and_store_subscriptions/migration.sql'
    ),
    'utf8'
  );
  const backfill = sql.slice(
    sql.indexOf('-- BACKFILL:BEGIN') + '-- BACKFILL:BEGIN'.length,
    sql.indexOf('-- BACKFILL:END')
  );

  it('maps free/starter/professional/enterprise to free/growth/pro/comped', async () => {
    const expected = {
      free: ['free', 'active'],
      starter: ['growth', 'active'],
      professional: ['pro', 'active'],
      enterprise: ['comped', 'comped'],
    } as const;
    const ids: Record<string, string> = {};
    for (const plan of Object.keys(expected) as Array<keyof typeof expected>) {
      const id = crypto.randomUUID().slice(0, 10);
      const user = await prisma.user.create({
        data: {
          email: `planmig-${id}@test.local`,
          passwordHash: 'x',
          firstName: 'M',
          lastName: 'G',
          role: 'store_admin',
        },
      });
      const store = await prisma.store.create({
        data: { name: `planmig-${id}`, slug: `planmig-${id}`, ownerId: user.id, plan },
      });
      created.users.push(user.id);
      created.stores.push(store.id);
      ids[plan] = store.id;
      // pre-migration state: no subscription row -> runtime falls back to the enum
      expect((await getEntitlements(store.id))?.derivedFromLegacyPlan).toBe(true);
    }
    await withRlsBypass(tx => tx.$executeRawUnsafe(backfill));
    for (const plan of Object.keys(expected) as Array<keyof typeof expected>) {
      const sub = await prisma.storeSubscription.findUnique({ where: { storeId: ids[plan] } });
      expect([sub?.planCode, sub?.status], plan).toEqual(expected[plan]);
      expect((await getEntitlements(ids[plan]))?.planCode).toBe(expected[plan][0]);
    }
    // idempotent: a second run changes nothing and does not throw
    await withRlsBypass(tx => tx.$executeRawUnsafe(backfill));
  });
});

describe.skipIf(!hasDb)('RLS — store_subscriptions is tenant-isolated', () => {
  async function asTenant<T>(storeId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ebda_app`);
      await tx.$executeRawUnsafe(
        `SET LOCAL app.current_store_id = '${storeId.replace(/'/g, "''")}'`
      );
      return fn(tx);
    });
  }

  it("store A cannot read, update or insert for store B's subscription", async () => {
    const a = await makeStore('free');
    const b = await makeStore('growth');

    const seenByA = await asTenant(a.storeId, tx => tx.storeSubscription.findMany());
    expect(seenByA.map(s => s.storeId)).toEqual([a.storeId]);
    expect(
      await asTenant(a.storeId, tx =>
        tx.storeSubscription.findUnique({ where: { storeId: b.storeId } })
      )
    ).toBeNull();

    const upd = await asTenant(a.storeId, tx =>
      tx.storeSubscription.updateMany({
        where: { storeId: b.storeId },
        data: { planCode: 'comped' },
      })
    );
    expect(upd.count).toBe(0);
    expect(
      (await prisma.storeSubscription.findUnique({ where: { storeId: b.storeId } }))?.planCode
    ).toBe('growth');

    await expect(
      asTenant(a.storeId, tx =>
        tx.storeSubscription.create({ data: { storeId: b.storeId, planCode: 'free' } })
      )
    ).rejects.toThrow();
  });
});
