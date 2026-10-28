/**
 * Lifecycle emails against a real database on the strict `ebda_app` role (RLS): the idempotency row
 * (UNIQUE store + kind), tenant isolation of the log, the real skip rules (SetupGuideService reading
 * real products/orders), the opt-out, and the super-admin referral counts. Only the email enqueue is
 * stubbed: what is asserted is that it is called once, with the right owner.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  createPrismaClient,
  runWithRequestDb,
  withStore,
  asPlatformOperator,
  type AppPrismaClient,
} from '@ebda/database';

const sendMock = vi.hoisted(() => vi.fn());
vi.mock('../../apps/api/src/services/email.service', () => ({
  EmailService: { sendLifecycleEmail: sendMock },
}));

import {
  listLifecycleLog,
  optOut,
  processLifecycleEmail,
  referralSignupCounts,
} from '../../apps/api/src/services/lifecycle-emails.service';
import { setAppRoleLogin } from '../helpers/app-role-login';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const PREFIX = `tst-${crypto.randomUUID().slice(0, 8)}-`;

let owner: AppPrismaClient;
const ids = { storeA: '', storeB: '', admin: '' };

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}
/** Run `fn` the way a request/job does in production: its own ebda_app client, no ambient tenant. */
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 2 }), fn);

async function seedStore(tag: string) {
  const u = await owner.user.create({
    data: {
      email: `${PREFIX}${tag}-owner@test.com`,
      passwordHash: 'x',
      firstName: tag,
      lastName: 'O',
      role: 'store_admin' as never,
    },
  });
  const store = await owner.store.create({
    data: { slug: `${PREFIX}${tag}`, name: tag, ownerId: u.id },
  });
  const plan = await owner.plan.findFirst({ select: { code: true } });
  await owner.storeSubscription.create({
    data: {
      storeId: store.id,
      planCode: plan!.code,
      status: 'trialing' as never,
      trialEndsAt: new Date(Date.now() + 10 * 86_400_000),
    },
  });
  return store.id;
}

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: OWNER_URL, max: 3, role: 'owner' });
  await setAppRoleLogin(owner, APP_PASSWORD);
  ids.storeA = await seedStore('a');
  ids.storeB = await seedStore('b');
  const admin = await owner.user.create({
    data: {
      email: `${PREFIX}admin@test.com`,
      passwordHash: 'x',
      firstName: 'Ad',
      lastName: 'Min',
      role: 'super_admin' as never,
    },
  });
  ids.admin = admin.id;
});

afterAll(async () => {
  const inPrefix = `IN (SELECT id FROM public.stores WHERE slug LIKE '${PREFIX}%')`;
  for (const t of ['store_lifecycle_emails', 'store_subscriptions', 'products'])
    await owner.$executeRawUnsafe(`DELETE FROM public.${t} WHERE store_id ${inPrefix}`);
  await owner.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${PREFIX}%'`);
  await owner.$disconnect();
});

describe('store_lifecycle_emails on the strict ebda_app role', () => {
  it('sends a nudge exactly once (the unique row is the lock), to the owner, and logs it', () =>
    asApp(async () => {
      sendMock.mockReset();
      sendMock.mockResolvedValue(undefined);
      expect(await processLifecycleEmail(ids.storeA, 'add_products')).toEqual({ status: 'sent' });
      expect(await processLifecycleEmail(ids.storeA, 'add_products')).toEqual({
        status: 'duplicate',
      });
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock.mock.calls[0][0].to).toBe(`${PREFIX}a-owner@test.com`);
      const log = await listLifecycleLog(ids.storeA);
      expect(log.entries.find(e => e.kind === 'add_products')?.status).toBe('sent');
    }));

  it('reads REAL state: once a product exists the day-1 nudge is skipped with its reason', () =>
    asApp(async () => {
      sendMock.mockReset();
      await owner.product.create({
        data: {
          storeId: ids.storeB,
          name: 'p',
          slug: `${PREFIX}b-p`,
          price: 100,
          status: 'active' as never,
        },
      });
      expect(await processLifecycleEmail(ids.storeB, 'add_products')).toEqual({
        status: 'skipped',
        reason: 'products_added',
      });
      expect(sendMock).not.toHaveBeenCalled();
      const log = await listLifecycleLog(ids.storeB);
      expect(log.entries.find(e => e.kind === 'add_products')).toMatchObject({
        status: 'skipped',
        reason: 'products_added',
      });
    }));

  it("is tenant-isolated: store A's context cannot see store B's rows", () =>
    asApp(async () => {
      const seen = await withStore(
        ids.storeA,
        tx =>
          tx.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*)::bigint AS n FROM store_lifecycle_emails WHERE store_id = ${ids.storeB}`
      );
      expect(Number(seen[0].n)).toBe(0);
    }));

  it('the DB itself refuses an unknown kind, an unknown status and a second row for one kind', async () => {
    await expect(
      owner.$executeRawUnsafe(
        `INSERT INTO store_lifecycle_emails (id, store_id, kind, status) VALUES ('${crypto.randomUUID()}', '${ids.storeA}', 'bogus', 'sent')`
      )
    ).rejects.toThrow();
    await expect(
      owner.$executeRawUnsafe(
        `INSERT INTO store_lifecycle_emails (id, store_id, kind, status) VALUES ('${crypto.randomUUID()}', '${ids.storeA}', 'test_order', 'weird')`
      )
    ).rejects.toThrow();
    await expect(
      owner.$executeRawUnsafe(
        `INSERT INTO store_lifecycle_emails (id, store_id, kind, status) VALUES ('${crypto.randomUUID()}', '${ids.storeA}', 'add_products', 'sent')`
      )
    ).rejects.toThrow();
  });

  it('the unsubscribe sticks: after opt-out nothing is sent, and the log says so', () =>
    asApp(async () => {
      sendMock.mockReset();
      await optOut(ids.storeA);
      await optOut(ids.storeA); // idempotent
      expect(await processLifecycleEmail(ids.storeA, 'share_link')).toEqual({
        status: 'skipped',
        reason: 'opted_out',
      });
      expect(sendMock).not.toHaveBeenCalled();
      expect((await listLifecycleLog(ids.storeA)).optedOut).toBe(true);
      expect((await listLifecycleLog(ids.storeB)).optedOut).toBe(false);
    }));

  it('deleting the store removes its log (FK cascade)', async () => {
    const s = await owner.store.create({
      data: {
        slug: `${PREFIX}gone`,
        name: 'gone',
        ownerId: (await owner.store.findFirst({ where: { id: ids.storeA } }))!.ownerId,
      },
    });
    await owner.$executeRawUnsafe(
      `INSERT INTO store_lifecycle_emails (id, store_id, kind, status) VALUES ('${crypto.randomUUID()}', '${s.id}', 'share_link', 'sent')`
    );
    await owner.$executeRawUnsafe(`DELETE FROM public.stores WHERE id = '${s.id}'`);
    const left = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM store_lifecycle_emails WHERE store_id = '${s.id}'`
    );
    expect(Number(left[0].n)).toBe(0);
  });
});

describe('referral signup counts (super-admin)', () => {
  it('counts owners whose first touch was the store badge or the referral email', () =>
    asApp(async () => {
      const before = await asPlatformOperator(ids.admin, () => referralSignupCounts());
      const acq = (source: string) => ({
        v: 1,
        attribution: { utm_source: source, first_seen: 1 },
        consent: { analytics: true, marketing: false },
        capturedAt: new Date().toISOString(),
      });
      await owner.user.create({
        data: {
          email: `${PREFIX}ref1@test.com`,
          passwordHash: 'x',
          firstName: 'R',
          lastName: '1',
          role: 'store_admin' as never,
          acquisition: acq('ebda_store_badge'),
        },
      });
      await owner.user.create({
        data: {
          email: `${PREFIX}ref2@test.com`,
          passwordHash: 'x',
          firstName: 'R',
          lastName: '2',
          role: 'store_admin' as never,
          acquisition: acq('meta'),
        },
      });
      const after = await asPlatformOperator(ids.admin, () => referralSignupCounts());
      expect(after.badge - before.badge).toBe(1);
      expect(after.email - before.email).toBe(0);
    }));
});
