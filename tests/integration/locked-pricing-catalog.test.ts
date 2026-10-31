/**
 * Locked pricing against a real Postgres (migrations applied): the catalog the
 * migration leaves behind, the store-count / analytics / branding gates through
 * the real engine, and that stores already on hidden plans keep working.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import { prisma, withRlsBypass } from '@ebda/database';
import { DEFAULT_PLAN_SEEDS, planLimitsSchema } from '@ebda/shared';
import {
  assertAnalyticsTier,
  assertOwnerMayCreateStore,
} from '../../apps/api/src/services/plan-limit.service';
import { getEntitlements } from '../../apps/api/src/services/plan-entitlements';
import { planService } from '../../apps/api/src/services/plan.service';
import { featureService } from '../../apps/api/src/services/feature.service';
import { StoreService } from '../../apps/api/src/services/store.service';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const created = { stores: [] as string[], users: [] as string[] };

async function makeOwner() {
  const id = crypto.randomUUID().slice(0, 10);
  const user = await prisma.user.create({
    data: {
      email: `lockedp-${id}@test.local`,
      passwordHash: 'x',
      firstName: 'L',
      lastName: 'P',
      role: 'store_admin',
    },
  });
  created.users.push(user.id);
  return user.id;
}

async function makeStore(ownerId: string, planCode: string, status?: 'trialing' | 'active') {
  const id = crypto.randomUUID().slice(0, 10);
  const store = await prisma.store.create({
    data: { name: `lockedp-${id}`, slug: `lockedp-${id}`, ownerId, status: 'active' },
  });
  created.stores.push(store.id);
  await planService.assignPlan(store.id, { planCode, ...(status ? { status } : {}) });
  return store.id;
}

afterAll(async () => {
  if (!hasDb) return;
  await withRlsBypass(async tx => {
    await tx.storeSubscription.deleteMany({ where: { storeId: { in: created.stores } } });
    await tx.storeFeature.deleteMany({ where: { storeId: { in: created.stores } } });
    await tx.taxRate.deleteMany({ where: { storeId: { in: created.stores } } });
    await tx.store.deleteMany({ where: { id: { in: created.stores } } });
    await tx.user.deleteMany({ where: { id: { in: created.users } } });
  });
});

describe.skipIf(!hasDb)('catalog after migrations', () => {
  it('has exactly the seven locked rows, identical to DEFAULT_PLAN_SEEDS', async () => {
    const rows = await prisma.plan.findMany({
      where: { code: { in: DEFAULT_PLAN_SEEDS.map(p => p.code) } },
    });
    expect(rows).toHaveLength(DEFAULT_PLAN_SEEDS.length);
    for (const seed of DEFAULT_PLAN_SEEDS) {
      const row = rows.find(r => r.code === seed.code)!;
      expect(planLimitsSchema.parse(row.limits), seed.code).toEqual(seed.limits);
      expect([row.isPublic, row.priceMonthlyMinor, row.priceYearlyMinor], seed.code).toEqual([
        seed.isPublic,
        seed.priceMonthlyMinor,
        seed.priceYearlyMinor,
      ]);
      expect(row.featureTier).toBe(seed.featureTier);
    }
  });

  it('only Basic / Growth / Business are public, every plan has a zero platform + COD fee', async () => {
    const all = await prisma.plan.findMany();
    const publicCodes = all
      .filter(p => p.isPublic)
      .map(p => p.code)
      .sort();
    // other suites' throwaway plans are private; the public set is exactly the locked three
    expect(publicCodes).toEqual(['basic', 'business', 'growth']);
    for (const p of all.filter(x => DEFAULT_PLAN_SEEDS.some(s => s.code === x.code))) {
      const l = planLimitsSchema.parse(p.limits);
      expect([l.platformFeeBps, l.codPlatformFeeBps]).toEqual([0, 0]);
    }
  });

  it('re-running the migration SQL is a no-op for stores already on hidden plans', async () => {
    const owner = await makeOwner();
    const ids: Record<string, string> = {};
    for (const code of ['free', 'pro', 'comped', 'founding_free']) {
      ids[code] = await makeStore(owner, code);
    }
    const sql = fs.readFileSync(
      'packages/database/prisma/migrations/20261007000000_locked_pricing/migration.sql',
      'utf8'
    );
    for (const stmt of sql.split(/;\s*\n/).filter(s => /INSERT INTO plans/.test(s))) {
      await prisma.$executeRawUnsafe(stmt.slice(stmt.indexOf('INSERT INTO plans')));
    }
    // The replay is the migration history IN ORDER: the later migrations that merge a key into
    // plans.limits re-apply too (B2B-1 adds "wholesalePricing", Business gets "whatsappAutomation", CATIMP-2 adds "catalogImportPagesPerMonth"), or the
    // blob stops matching the seeds, and the replay would leave the shared catalog stale for every later test.
    for (const migration of [
      '20261028000200_b2b_product_columns_order_snapshots',
      '20261104000200_business_plan_includes_whatsapp',
      '20261108000200_catalog_import_plan_limits',
    ]) {
      const later = fs.readFileSync(
        `packages/database/prisma/migrations/${migration}/migration.sql`,
        'utf8'
      );
      for (const stmt of later
        .split(/;\s*\n/)
        .filter(s => /UPDATE "plans"\s+SET "limits"/.test(s))) {
        await prisma.$executeRawUnsafe(stmt.slice(stmt.indexOf('UPDATE "plans"')));
      }
    }
    for (const [code, storeId] of Object.entries(ids)) {
      const e = await getEntitlements(storeId);
      expect(e?.subscribedPlanCode).toBe(code);
      expect(e?.planCode).toBe(code);
      // resolved from the plan row, not the corrupt-JSON seed fallback
      expect(e?.limits).toEqual(DEFAULT_PLAN_SEEDS.find(p => p.code === code)!.limits);
    }
    expect((await getEntitlements(ids.comped))?.status).toBe('comped');
    expect((await getEntitlements(ids.founding_free))?.status).toBe('comped'); // assignPlan forces it
  });
});

describe.skipIf(!hasDb)('store-count gate through the real engine', () => {
  it('Basic owner: second store refused with 402; Business owner: 2nd and 3rd ok, 4th refused', async () => {
    const basicOwner = await makeOwner();
    await makeStore(basicOwner, 'basic');
    await expect(
      StoreService.create(basicOwner, { name: 'Second basic store' })
    ).rejects.toMatchObject({ statusCode: 402, code: 'PLAN_LIMIT_REACHED' });
    await expect(assertOwnerMayCreateStore(basicOwner)).rejects.toMatchObject({ statusCode: 402 });

    const bizOwner = await makeOwner();
    await makeStore(bizOwner, 'business');
    const second = await StoreService.create(bizOwner, { name: `Biz two ${Date.now()}` });
    created.stores.push(second.id);
    const third = await StoreService.create(bizOwner, { name: `Biz three ${Date.now()}` });
    created.stores.push(third.id);
    await expect(StoreService.create(bizOwner, { name: 'Biz four' })).rejects.toMatchObject({
      statusCode: 402,
      details: { limitKey: 'maxStores', limit: 3, used: 3 },
    });
    // the platform operator path is not plan-bound
    const op = await StoreService.create(
      basicOwner,
      { name: `Operator made ${Date.now()}` },
      { platformOperator: true }
    );
    created.stores.push(op.id);
  });
});

describe.skipIf(!hasDb)('branding, API access and analytics through the real feature map', () => {
  it('Basic keeps the footer and has no API; Growth drops the footer and gets MCP; Business keeps both', async () => {
    const owner = await makeOwner();
    const basic = await makeStore(owner, 'basic');
    const growth = await makeStore(owner, 'growth');
    const business = await makeStore(owner, 'business');
    for (const id of [basic, growth, business]) await featureService.invalidateCache(id);
    const f = async (id: string) => {
      const m = await featureService.getStoreFeatures(id);
      return [m.remove_branding, m.merchant_mcp];
    };
    expect(await f(basic)).toEqual([false, false]);
    expect(await f(growth)).toEqual([true, true]); // MCP: Growth + Business (2026-10-14)
    expect(await f(business)).toEqual([true, true]);

    await expect(assertAnalyticsTier(basic, 'standard')).rejects.toMatchObject({
      statusCode: 402,
    });
    await expect(assertAnalyticsTier(growth, 'standard')).resolves.toBeUndefined();
    await expect(assertAnalyticsTier(growth, 'advanced')).rejects.toMatchObject({
      statusCode: 402,
    });
    await expect(assertAnalyticsTier(business, 'advanced')).resolves.toBeUndefined();
  });
});
