/**
 * Webhook routing resolves a provider reference to its store WITHIN the provider, preferring the store the
 * per-store webhook URL names (Ruling ITEST-14). The old `ebda_webhook_resolve_store` matched any payment with
 * that reference string and took `LIMIT 1` with no ORDER BY, so two payments sharing a reference (another
 * provider's, another merchant's, the small repeating ids the stubs mint) made the owning store arbitrary and the
 * delivery to the right URL was ignored as "another store's payment". Runs as `ebda_app`, like production.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { createPrismaClient, runWithRequestDb, type AppPrismaClient } from '@ebda/database';
import { resolveStoreFromWebhookRef } from '@api/lib/definer';
import { hasDb } from '../helpers/bundle-fixtures';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 2 }), fn);

describe.skipIf(!hasDb)(
  'webhook store resolution is scoped to the provider and the URL store',
  () => {
    const run = crypto.randomUUID().slice(0, 8);
    const ref = `dup-ref-${run}`;
    const owner: AppPrismaClient | null = hasDb
      ? createPrismaClient({ connectionString: OWNER_URL, max: 2, role: 'owner' })
      : null;
    const stores: string[] = [];
    const users: string[] = [];

    async function mk(tag: string, provider: string, transactionId: string | null) {
      const user = await owner!.user.create({
        data: {
          email: `wrs-${tag}-${run}@test.local`,
          passwordHash: 'x',
          firstName: 'W',
          lastName: tag,
          role: 'store_admin',
          emailVerified: true,
        },
      });
      users.push(user.id);
      const store = await owner!.store.create({
        data: {
          name: `wrs-${tag}-${run}`,
          slug: `wrs-${tag}-${run}`,
          ownerId: user.id,
          status: 'active',
        },
      });
      stores.push(store.id);
      const order = await owner!.order.create({
        data: {
          storeId: store.id,
          orderNumber: `WRS-${tag}-${run}`,
          status: 'pending',
          paymentStatus: 'unpaid',
          subtotal: 1000,
          total: 1000,
          shippingAddress: {},
          billingAddress: {},
        },
      });
      await owner!.payment.create({
        data: { orderId: order.id, provider, amount: 1000, status: 'pending', transactionId },
      });
      return store.id;
    }

    afterAll(async () => {
      await owner!.payment
        .deleteMany({ where: { order: { storeId: { in: stores } } } })
        .catch(() => undefined);
      await owner!.order.deleteMany({ where: { storeId: { in: stores } } }).catch(() => undefined);
      await owner!.store.deleteMany({ where: { id: { in: stores } } }).catch(() => undefined);
      await owner!.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
      await owner!.$disconnect();
    });

    it('the same reference in two stores and two providers resolves to the right owner', async () => {
      const paymobA = await mk('pa', 'paymob', ref);
      const paymobB = await mk('pb', 'paymob', ref);
      const kashierC = await mk('kc', 'kashier', ref);

      const r = (extra: object) =>
        asApp(() => resolveStoreFromWebhookRef({ transactionId: ref, ...extra }));

      // the URL's store wins between two stores of the same provider, in either direction
      expect(await r({ provider: 'paymob', preferStoreId: paymobA })).toBe(paymobA);
      expect(await r({ provider: 'paymob', preferStoreId: paymobB })).toBe(paymobB);
      // the provider filter keeps another provider's payment out, even when it is the preferred store
      expect(await r({ provider: 'kashier' })).toBe(kashierC);
      expect(await r({ provider: 'paymob', preferStoreId: kashierC })).not.toBe(kashierC);
      // no payment of that provider: nothing (and no store is leaked)
      expect(await r({ provider: 'fawry', preferStoreId: paymobA })).toBeNull();
      // an unknown reference
      expect(
        await asApp(() =>
          resolveStoreFromWebhookRef({ transactionId: `nope-${run}`, provider: 'paymob' })
        )
      ).toBeNull();
      // deterministic without a preference: the same answer every time (newest payment first)
      const first = await r({ provider: 'paymob' });
      for (let i = 0; i < 5; i++) expect(await r({ provider: 'paymob' })).toBe(first);
    });
  }
);
