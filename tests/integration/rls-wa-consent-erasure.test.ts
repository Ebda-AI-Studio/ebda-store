/**
 * WA-CONSENT-1 under the REAL `ebda_app` role (strict RLS): the whole consent lifecycle through the
 * real services, not mocks. This is the regression net for the tenant-context class of bug: the
 * ownership proof reads `orders`, and `eraseAccount` scrubs those orders, so (a) the proof must run
 * inside the tenant scope with the right store id, and (b) BEFORE the scrub. Under RLS a proof run
 * outside the scope silently reads zero rows and the consent row would survive the erasure.
 *
 * Runs in the "RLS ebda_app Strict-Policy Proof" CI job (superuser URL for fixtures only; every
 * assertion path runs on an ebda_app connection via `runWithRequestDb`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { TextFallbackClient } from '../../packages/database/src/client';
import {
  createPrismaClient,
  runWithRequestDb,
  runInTenantContext,
  withOwnerTx,
  prisma,
  type AppPrismaClient,
} from '@ebda/database';
import { buyerKeyFor } from '@ebda/shared';
import { setAppRoleLogin } from '../helpers/app-role-login';
import { AuthService } from '../../apps/api/src/services/auth.service';
import { WhatsAppConsentService, phoneOnOwnOrder } from '../../apps/api/src/lib/wa/consent';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw'; // roles are cluster-wide: never rotate it
const PREFIX = 'wacon-';
const SECRET = 'ebda-suite-buyer-key-test-v1-padded-to-32-chars';
const PHONE = '01001234567';
const OTHER_PHONE = '01112345678';

const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');

let owner: AppPrismaClient;
const makeApp = (): AppPrismaClient => {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return new PrismaClient({
    adapter: new PrismaPg(
      new pg.Pool({ connectionString: u.toString(), max: 2, Client: TextFallbackClient }),
      { disposeExternalPool: true }
    ),
  }) as unknown as AppPrismaClient;
};
const asApp = <T>(fn: () => Promise<T>): Promise<T> => runWithRequestDb(makeApp, fn);

async function cleanup(): Promise<void> {
  await withOwnerTx(async tx => {
    const stores = `(SELECT id FROM public.stores WHERE slug LIKE '${PREFIX}%')`;
    await tx.$executeRawUnsafe(
      `DELETE FROM public.store_whatsapp_consents WHERE store_id IN ${stores}`
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM public.order_items WHERE order_id IN (SELECT id FROM public.orders WHERE store_id IN ${stores})`
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM public.payments WHERE order_id IN (SELECT id FROM public.orders WHERE store_id IN ${stores})`
    );
    await tx.$executeRawUnsafe(`DELETE FROM public.orders WHERE store_id IN ${stores}`);
    await tx.$executeRawUnsafe(`DELETE FROM public.carts WHERE store_id IN ${stores}`);
    await tx.$executeRawUnsafe(`DELETE FROM public.audit_logs WHERE store_id IN ${stores}`);
    await tx.$executeRawUnsafe(`DELETE FROM public.users WHERE store_id IN ${stores}`);
    await tx.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${PREFIX}%'`);
    await tx.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${PREFIX}%'`);
  });
}

describe.skipIf(!hasDb)('WhatsApp marketing consent under strict RLS (ebda_app)', () => {
  let storeId = '';
  let customerId = '';
  let otherCustomerId = '';
  let key = '';
  let otherKey = '';
  const session = `${PREFIX}sess-${crypto.randomUUID()}`;

  beforeAll(async () => {
    process.env.SUITE_BUYER_KEY_SECRET = SECRET;
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 3, role: 'owner' });
    await setAppRoleLogin(owner, APP_PASSWORD);
    await cleanup();
    key = (await buyerKeyFor(SECRET, PHONE))!;
    otherKey = (await buyerKeyFor(SECRET, OTHER_PHONE))!;

    const mk = (tag: string, role: string, sid: string | null, phone: string | null) =>
      owner.user.create({
        data: {
          email: `${PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`,
          passwordHash: 'hashed',
          firstName: tag,
          lastName: 'T',
          role: role as never,
          storeId: sid,
          phone,
        },
      });
    const storeOwner = await mk('owner', 'store_admin', null, null);
    const store = await owner.store.create({
      data: { slug: `${PREFIX}a`, name: 'WA consent', ownerId: storeOwner.id },
    });
    storeId = store.id;
    customerId = (await mk('cust', 'customer', storeId, PHONE)).id;
    otherCustomerId = (await mk('other', 'customer', storeId, OTHER_PHONE)).id;

    const order = (customer: string, phone: string, status: string) =>
      owner.order.create({
        data: {
          storeId,
          customerId: customer,
          orderNumber: `${PREFIX}o-${Math.random().toString(36).slice(2, 8)}`,
          subtotal: 10,
          total: 10,
          status: status as never,
          shippingAddress: { phone },
          billingAddress: {},
        },
      });
    await order(customerId, PHONE, 'delivered'); // proves PHONE for the customer
    await order(otherCustomerId, OTHER_PHONE, 'pending'); // a pending order proves nothing
    await owner.cart.create({ data: { storeId, sessionId: session, customerId } });
  });

  afterAll(async () => {
    await cleanup();
    await owner?.$disconnect();
  });

  const consentRows = (buyerKey: string) =>
    owner.storeWhatsAppConsent.findMany({ where: { storeId, buyerKey } });

  it('the proof reads the delivered order under RLS (inside the tenant scope), not a pending one', async () => {
    expect(
      await asApp(() =>
        runInTenantContext(storeId, () => phoneOnOwnOrder(storeId, customerId, PHONE))
      )
    ).toBe(true);
    expect(
      await asApp(() =>
        runInTenantContext(storeId, () => phoneOnOwnOrder(storeId, otherCustomerId, OTHER_PHONE))
      )
    ).toBe(false);
    // Outside any tenant scope the proof still holds: with no caller client it reads through the store's own backend
    // (`storeDb`, NEON-ZERO 2026-11-09), which scopes the Postgres read to THIS store itself (a DO store reads its DO). The old
    // failure mode (a contextless read under strict RLS returning nothing, a silently false proof) cannot happen any more.
    expect(await asApp(() => phoneOnOwnOrder(storeId, customerId, PHONE))).toBe(true);
    expect(await asApp(() => phoneOnOwnOrder(storeId, otherCustomerId, OTHER_PHONE))).toBe(false);
  });

  it('a proven grant is recorded and bound to the account; an unproven one is refused', async () => {
    const granted = await asApp(() =>
      runInTenantContext(storeId, () =>
        WhatsAppConsentService.recordForCart(storeId, session, customerId, { consent: true })
      )
    );
    expect(granted).toMatchObject({ status: 'recorded', granted: true });
    expect(await consentRows(key)).toMatchObject([{ granted: true, userId: customerId }]);

    await owner.cart.create({
      data: { storeId, sessionId: `${session}-o`, customerId: otherCustomerId },
    });
    const refused = await asApp(() =>
      runInTenantContext(storeId, () =>
        WhatsAppConsentService.recordForCart(storeId, `${session}-o`, otherCustomerId, {
          consent: true,
        })
      )
    );
    expect(refused).toEqual({ status: 'phone_unproven' });
    expect(await consentRows(otherKey)).toHaveLength(0);
  });

  it('the account export lists the bound row (ebda_app, tenant scope)', async () => {
    const rows = await asApp(() =>
      runInTenantContext(storeId, () =>
        WhatsAppConsentService.exportForAccount(storeId, customerId, key)
      )
    );
    expect(rows).toHaveLength(1);
  });

  it('eraseAccount (the real flow, ebda_app) deletes the consent row: the proof runs before the order scrub', async () => {
    await AuthService.eraseAccount(customerId);
    expect(await consentRows(key)).toHaveLength(0);
    // the orders WERE scrubbed (so a late proof could not have found them)
    const orders = await owner.order.findMany({
      where: { storeId, shippingAddress: { path: ['phone'], equals: PHONE } },
    });
    expect(orders).toHaveLength(0);
  });

  it('a grant racing a phone change never leaves the OLD number opted in (two real concurrent transactions)', async () => {
    const P3 = '01223334445';
    const P4 = '01556667778';
    const key3 = (await buyerKeyFor(SECRET, P3))!;
    for (let i = 0; i < 6; i++) {
      const u = await owner.user.create({
        data: {
          email: `${PREFIX}race${i}-${Date.now()}@test.com`,
          passwordHash: 'hashed',
          firstName: 'r',
          lastName: 'T',
          role: 'customer' as never,
          storeId,
          phone: P3,
        },
      });
      await owner.order.create({
        data: {
          storeId,
          customerId: u.id,
          orderNumber: `${PREFIX}r-${i}-${Math.random().toString(36).slice(2, 6)}`,
          subtotal: 10,
          total: 10,
          status: 'delivered' as never,
          shippingAddress: { phone: P3 },
          billingAddress: {},
        },
      });
      const sess = `${PREFIX}race-${i}-${crypto.randomUUID()}`;
      await owner.cart.create({ data: { storeId, sessionId: sess, customerId: u.id } });
      await Promise.all([
        asApp(() =>
          WhatsAppConsentService.recordForCart(storeId, sess, u.id, { consent: true })
        ).catch(() => null),
        asApp(() => AuthService.updateProfile(u.id, { phone: P4 })),
      ]);
      // Whatever the interleaving: P3 is no longer the account's number, so it must not be opted in.
      const rows = await owner.storeWhatsAppConsent.findMany({
        where: { storeId, buyerKey: key3, granted: true, userId: u.id },
      });
      expect(rows).toHaveLength(0);
      await owner.storeWhatsAppConsent.deleteMany({ where: { storeId, buyerKey: key3 } });
    }
  });
});
