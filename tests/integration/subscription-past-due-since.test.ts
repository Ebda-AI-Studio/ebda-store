/**
 * WA-GRACE-1: `store_subscriptions.past_due_since` is maintained by a trigger, so every write path is
 * covered. Set once on the transition into past_due (a later retry does not move it), cleared on any
 * other status, and set on an INSERT that is already past_due. Superuser URL; the trigger is data-layer
 * only. Runs in the "RLS ebda_app Strict-Policy Proof" CI job (real Postgres, all migrations applied).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPrismaClient, withOwnerTx, type AppPrismaClient } from '@ebda/database';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const PREFIX = 'pdsince-';

describe.skipIf(!hasDb)('store_subscriptions.past_due_since trigger', () => {
  let owner: AppPrismaClient;
  let storeId = '';

  const since = async (): Promise<Date | null> =>
    (await owner.storeSubscription.findUniqueOrThrow({ where: { storeId } })).pastDueSince;

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 2, role: 'owner' });
    await withOwnerTx(async tx => {
      await tx.$executeRawUnsafe(
        `DELETE FROM public.store_subscriptions WHERE store_id IN (SELECT id FROM public.stores WHERE slug LIKE '${PREFIX}%')`
      );
      await tx.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${PREFIX}%'`);
      await tx.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${PREFIX}%'`);
    });
    const u = await owner.user.create({
      data: {
        email: `${PREFIX}${Date.now()}@test.com`,
        passwordHash: 'x',
        firstName: 'p',
        lastName: 'd',
        role: 'store_admin' as never,
      },
    });
    const s = await owner.store.create({ data: { slug: `${PREFIX}a`, name: 'PD', ownerId: u.id } });
    storeId = s.id;
    await owner.storeSubscription.create({
      data: { storeId, planCode: 'business', status: 'active' },
    });
  });

  afterAll(async () => {
    await withOwnerTx(async tx => {
      await tx.$executeRawUnsafe(
        `DELETE FROM public.store_subscriptions WHERE store_id = '${storeId}'`
      );
      await tx.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${PREFIX}%'`);
      await tx.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${PREFIX}%'`);
    });
    await owner?.$disconnect();
  });

  it('is null while active, set on the first transition into past_due', async () => {
    expect(await since()).toBeNull();
    await owner.storeSubscription.update({ where: { storeId }, data: { status: 'past_due' } });
    expect(await since()).toBeInstanceOf(Date);
  });

  it('a later failed retry does not move it', async () => {
    const first = await since();
    await new Promise(r => setTimeout(r, 25));
    await owner.storeSubscription.update({
      where: { storeId },
      data: { status: 'past_due', dunningAttempts: 2 },
    });
    expect((await since())!.getTime()).toBe(first!.getTime());
  });

  it('is cleared when the subscription recovers, and a NEW past_due episode starts a new date', async () => {
    const first = await since();
    await owner.storeSubscription.update({ where: { storeId }, data: { status: 'active' } });
    expect(await since()).toBeNull();
    await new Promise(r => setTimeout(r, 25));
    await owner.storeSubscription.update({ where: { storeId }, data: { status: 'past_due' } });
    expect((await since())!.getTime()).toBeGreaterThan(first!.getTime());
  });

  it('an INSERT that is already past_due gets a date; any non-past_due insert stays null', async () => {
    await owner.storeSubscription.delete({ where: { storeId } });
    await owner.storeSubscription.create({
      data: { storeId, planCode: 'business', status: 'past_due' },
    });
    expect(await since()).toBeInstanceOf(Date);
    await owner.storeSubscription.delete({ where: { storeId } });
    await owner.storeSubscription.create({
      data: { storeId, planCode: 'business', status: 'active' },
    });
    expect(await since()).toBeNull();
  });
});
