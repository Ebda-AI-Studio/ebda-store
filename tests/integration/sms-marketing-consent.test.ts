/**
 * Issue 206 — promotional-SMS consent, per customer per store.
 *
 * Real Postgres, the real dispatcher, the real order create path, the real
 * account + opt-out routes. Only the SMS queue is spied (nothing is sent)
 * and `authenticate` is replaced by a header-driven stub.
 *
 * Mutation proof (each turns a test here red; restored byte-identical):
 *  M1 dispatcher gate: `!(consentId = …)` → `false` (no consent read) →
 *     "no consent → no promotional SMS" goes red.
 *  M2 `findActiveForPhone`: drop `granted: true` → "withdrawn consent → no
 *     SMS" goes red.
 *  M3 `findActiveForPhone`: drop `storeId` from the where → "another
 *     store's consent does not count" goes red.
 *  M4 order create: drop the `recordGrant` call → "a ticked checkout box
 *     records consent" goes red.
 *  M5 `consentScope` (issue 2423): drop the phone from the read → "a guest
 *     opt-in shows on the account the same phone registers later" goes red.
 *  M6 `statusForKeys` (issue 2423): drop the phoneKey branch → the admin-list
 *     half of the same test goes red.
 *  M7 `storefrontBase` (issue 2426): skip the cache → "the opt-out link reads
 *     the store once per fan-out" goes red.
 *
 * Fixtures are per-CALL unique (retry-safe).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { prisma, withRlsBypass } from '@ebda/database';

vi.mock('@api/middleware/auth', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/middleware/auth')>();
  return {
    ...actual,
    authenticate: (req: any, res: any, next: any) => {
      const uid = req.headers['x-test-user'];
      if (!uid) return res.status(401).json({ success: false });
      req.user = { userId: uid, role: req.headers['x-test-role'] ?? 'customer' };
      next();
    },
  };
});

import { accountRouter, publicRouter } from '@api/routes/sms-consent.routes';
import { errorHandler } from '@api/middleware/error-handler';
import {
  notificationDispatcher,
  __clearOptOutBaseCacheForTests,
} from '@api/services/notification-dispatcher.service';
import { notificationConfigService } from '@api/services/notification-config.service';
import { smsQueue } from '@api/services/sms-queue.service';
import { SmsConsentService } from '@api/services/sms-consent.service';
import { AuthService } from '@api/services/auth.service';
import { CartService } from '@api/services/cart.service';
import { OrderService } from '@api/services/order.service';
import { verifySmsOptOutToken, SMS_OPT_OUT_TOKEN_V3_LENGTH } from '@api/lib/sms-consent';
import { storefrontOrigin } from '@ebda/shared';
import { cartSessionId } from '../helpers/bundle-fixtures';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const uid = () => `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

/** A distinct Egyptian mobile (010/011/012/015 + 8 digits, local form) per call, so tests never share a phone. */
function egMobile(): string {
  const operator = ['0', '1', '2', '5'][crypto.randomInt(0, 4)];
  return `01${operator}${String(crypto.randomInt(0, 99_999_999)).padStart(8, '0')}`;
}

/** The consent phone key (digits, country code first) for a local Egyptian mobile. */
const egKey = (local: string) => `20${local.slice(1)}`;

async function seedStore(opts: { sms: boolean } = { sms: true }) {
  const id = uid();
  const storeId = await withRlsBypass(async tx => {
    const owner = await tx.user.create({
      data: {
        email: `smsc-owner-${id}@example.test`,
        passwordHash: 'x',
        role: 'store_admin',
        firstName: 'Sms',
        lastName: 'Owner',
      },
    });
    const store = await tx.store.create({
      data: {
        name: `smsc-${id}`,
        slug: `smsc-${id}`,
        template: 'qamar',
        currency: 'EGP',
        ownerId: owner.id,
        status: 'active',
      },
    });
    if (opts.sms) {
      await tx.storeFeature.create({
        data: { storeId: store.id, featureKey: 'sms', enabled: true },
      });
    }
    return store.id;
  });
  if (opts.sms) {
    await notificationConfigService.upsertConfig(storeId, 'sms', {
      provider: 'unifonic',
      credentials: { appSid: `app-${id}`, senderId: 'TEST' },
      enabled: true,
    });
  }
  return storeId;
}

async function seedCustomer(storeId: string, phone: string | null) {
  const id = uid();
  return withRlsBypass(tx =>
    tx.user.create({
      data: {
        email: `smsc-shopper-${id}@example.test`,
        passwordHash: 'x',
        role: 'customer',
        firstName: 'Shop',
        lastName: 'Per',
        phone,
        storeId,
      },
      select: { id: true, email: true },
    })
  );
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth/me/sms-consent', accountRouter);
  app.use('/api/v1/public/sms-consent', publicRouter);
  app.use(errorHandler);
  return app;
}

const cartData = (phone: string) => ({
  customerName: 'Shop Per',
  customerPhone: phone,
  orderNumber: `cart-${uid()}`,
  storeId: '',
  storeName: 'S',
  cartUrl: 'https://example.test/cart',
});

describe.skipIf(!hasDb)('SMS-marketing consent (issue 206)', () => {
  let enqueue: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    enqueue = vi.spyOn(smsQueue, 'enqueue').mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    enqueue.mockRestore();
  });

  const promoSentTo = (phone: string) =>
    enqueue.mock.calls.filter(
      ([m]: any[]) => m.recipientPhone === phone && String(m.event).startsWith('cart_abandoned')
    );

  it('no consent → no promotional SMS; transactional SMS still sends', async () => {
    const storeId = await seedStore();
    const phone = egMobile();
    await notificationDispatcher.dispatch(storeId, 'cart_abandoned_step1', {
      ...cartData(phone),
      storeId,
    });
    expect(promoSentTo(phone)).toHaveLength(0);

    await notificationDispatcher.dispatch(storeId, 'order_shipped', {
      customerName: 'Shop Per',
      customerPhone: phone,
      orderNumber: `ORD-${uid()}`,
      storeId,
      storeName: 'S',
    });
    expect(enqueue.mock.calls.some(([m]: any[]) => m.event === 'order_shipped')).toBe(true);
  });

  it('granted consent → promotional SMS sends, matched across phone formats, with a working opt-out link', async () => {
    const storeId = await seedStore();
    const local = egMobile();
    await SmsConsentService.recordGrant(storeId, {
      customerKey: `+20 ${local.slice(1, 4)} ${local.slice(4, 8)} ${local.slice(8)}`,
      phone: `+20 ${local.slice(1, 4)} ${local.slice(4, 8)} ${local.slice(8)}`,
      source: 'checkout',
    });
    await notificationDispatcher.dispatch(storeId, 'cart_abandoned_step1', {
      ...cartData(local),
      storeId,
    });
    const sent = promoSentTo(local);
    expect(sent).toHaveLength(1);
    const text: string = (sent[0][0] as any).messageText;
    const m = text.match(/\/sms-unsubscribe\?t=([A-Za-z0-9_.-]+)/);
    expect(m).not.toBeNull();
    // Issue 2426: the fixed-size suffix, on the platform-path base.
    expect(m![1]).toHaveLength(SMS_OPT_OUT_TOKEN_V3_LENGTH);
    const slug = (await withRlsBypass(tx =>
      tx.store.findUnique({ where: { id: storeId }, select: { slug: true } })
    ))!.slug;
    // The label follows the store's language, and a store with no defaultLanguage gets the region
    // default: Egyptian Arabic (SMS_OPT_OUT_LABEL.ar in notification-dispatcher.service).
    expect(
      text.endsWith(` إيقاف العروض: ${storefrontOrigin({ slug })}/sms-unsubscribe?t=${m![1]}`)
    ).toBe(true);
    const consentId = verifySmsOptOutToken(m![1]);
    expect(consentId).not.toBeNull();

    // The link withdraws consent: GET only validates, POST withdraws.
    const app = buildApp();
    const peek = await request(app).get(`/api/v1/public/sms-consent/unsubscribe?t=${m![1]}`);
    expect(peek.status).toBe(200);
    expect(peek.body.data.alreadyUnsubscribed).toBe(false);
    expect(peek.body.data.phone).not.toContain(local); // masked
    const stop = await request(app)
      .post(`/api/v1/public/sms-consent/unsubscribe?t=${m![1]}`)
      .send({});
    expect(stop.status).toBe(200);

    enqueue.mockClear();
    await notificationDispatcher.dispatch(storeId, 'cart_abandoned_step2', {
      ...cartData(local),
      storeId,
    });
    expect(promoSentTo(local)).toHaveLength(0);

    const tampered = await request(app).post(
      `/api/v1/public/sms-consent/unsubscribe?t=${m![1].slice(0, -2)}AA`
    );
    expect(tampered.status).toBe(400);
  });

  it('withdrawn consent → no SMS, even with an older granted guest row for the same phone', async () => {
    const storeId = await seedStore();
    const phone = egMobile();
    await SmsConsentService.recordGrant(storeId, { customerKey: phone, phone, source: 'checkout' });
    await SmsConsentService.recordGrant(storeId, {
      customerKey: `guest-${uid()}@example.test`,
      phone: egKey(phone),
      source: 'checkout',
    });
    const flipped = await SmsConsentService.revoke(storeId, { phone }, 'account');
    expect(flipped).toBe(2);
    await notificationDispatcher.dispatch(storeId, 'cart_abandoned_step1', {
      ...cartData(phone),
      storeId,
    });
    expect(promoSentTo(phone)).toHaveLength(0);
  });

  it("another store's consent does not count", async () => {
    const storeA = await seedStore();
    const storeB = await seedStore();
    const phone = egMobile();
    await SmsConsentService.recordGrant(storeA, { customerKey: phone, phone, source: 'checkout' });
    await notificationDispatcher.dispatch(storeB, 'cart_abandoned_step1', {
      ...cartData(phone),
      storeId: storeB,
    });
    expect(promoSentTo(phone)).toHaveLength(0);
  });

  it('back-in-stock SMS for two shoppers do not share one idempotency key', async () => {
    const storeId = await seedStore();
    const [p1, p2] = [egMobile(), egMobile()];
    for (const p of [p1, p2]) {
      await SmsConsentService.recordGrant(storeId, {
        customerKey: p,
        phone: p,
        source: 'checkout',
      });
      await notificationDispatcher.dispatch(storeId, 'back_in_stock', {
        customerName: 'X',
        customerPhone: p,
        orderNumber: '',
        dedupeKey: `prod_${p}_2026-10-01`,
        storeId,
        storeName: 'S',
        productName: 'P',
        productUrl: 'https://example.test/p',
      });
    }
    const keys = enqueue.mock.calls
      .filter(([m]: any[]) => m.event === 'back_in_stock')
      .map(([m]: any[]) => m.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it('availability: needs the sms feature, a configured provider and a promotional event on', async () => {
    const off = await seedStore({ sms: false });
    expect(await notificationDispatcher.isSmsMarketingAvailable(off)).toBe(false);

    const on = await seedStore();
    expect(await notificationDispatcher.isSmsMarketingAvailable(on)).toBe(true);

    await withRlsBypass(tx =>
      tx.notificationEventConfig.createMany({
        data: [
          'cart_abandoned_step1',
          'cart_abandoned_step2',
          'cart_abandoned_step3',
          'back_in_stock',
        ].map(event => ({ storeId: on, event, sms: false, push: true })),
      })
    );
    expect(await notificationDispatcher.isSmsMarketingAvailable(on)).toBe(false);
  });

  it('a ticked checkout box records consent under customerKeyOf; an unticked box records nothing', async () => {
    const storeId = await seedStore();
    const product = await withRlsBypass(tx =>
      tx.product.create({
        data: {
          storeId,
          name: `smsc-p-${uid()}`,
          slug: `smsc-p-${uid()}`,
          price: 1000,
          inventory: 50,
          status: 'active',
        },
      })
    );
    const place = async (smsOptIn: boolean | undefined, email: string, phone: string) => {
      const sessionId = cartSessionId('smsc');
      await CartService.getOrCreate(storeId, sessionId);
      await CartService.addItem(storeId, sessionId, product.id, 1);
      return OrderService.create(storeId, undefined, sessionId, {
        shippingAddress: {
          firstName: 'G',
          lastName: 'Uest',
          address1: 'Block 1',
          city: '',
          country: 'Egypt',
          phone,
          email,
        },
        paymentMethod: 'cod',
        ...(smsOptIn === undefined ? {} : { smsOptIn }),
      } as never);
    };

    const tickedPhone = egMobile();
    const tickedEmail = `Guest-${uid()}@Example.test`;
    const order = await place(true, tickedEmail, tickedPhone);
    expect(order.smsOptIn).toBe(true);
    const row = await withRlsBypass(tx =>
      tx.smsMarketingConsent.findUnique({
        where: { storeId_customerKey: { storeId, customerKey: tickedEmail.toLowerCase() } },
      })
    );
    expect(row?.granted).toBe(true);
    expect(row?.grantedSource).toBe('checkout');
    expect(row?.phoneKey).toBe(egKey(tickedPhone));

    const untickedPhone = egMobile();
    await place(false, `g2-${uid()}@example.test`, untickedPhone);
    await place(undefined, `g3-${uid()}@example.test`, untickedPhone);
    const none = await withRlsBypass(tx =>
      tx.smsMarketingConsent.count({ where: { storeId, phoneKey: egKey(untickedPhone) } })
    );
    expect(none).toBe(0);
  });

  it('account page: grant needs a phone, withdraw always works, and it drives the gate', async () => {
    const storeId = await seedStore();
    const phone = egMobile();
    const shopper = await seedCustomer(storeId, phone);
    const noPhone = await seedCustomer(storeId, null);
    const app = buildApp();
    const as = (u: string) => ({ 'x-test-user': u, 'x-store-id': storeId });

    const initial = await request(app).get('/api/v1/auth/me/sms-consent').set(as(shopper.id));
    expect(initial.status).toBe(200);
    expect(initial.body.data).toMatchObject({ available: true, consent: { status: 'none' } });

    const needPhone = await request(app)
      .put('/api/v1/auth/me/sms-consent')
      .set(as(noPhone.id))
      .send({ optIn: true });
    expect(needPhone.status).toBe(409);
    expect(needPhone.body.error.code).toBe('PHONE_REQUIRED');

    const grant = await request(app)
      .put('/api/v1/auth/me/sms-consent')
      .set(as(shopper.id))
      .send({ optIn: true });
    expect(grant.status).toBe(200);
    expect(grant.body.data.consent).toMatchObject({ status: 'granted', grantedSource: 'account' });

    await notificationDispatcher.dispatch(storeId, 'cart_abandoned_step1', {
      ...cartData(phone),
      storeId,
    });
    expect(promoSentTo(phone)).toHaveLength(1);

    const stop = await request(app)
      .put('/api/v1/auth/me/sms-consent')
      .set(as(shopper.id))
      .send({ optIn: false });
    expect(stop.body.data.consent).toMatchObject({ status: 'revoked', revokedSource: 'account' });

    enqueue.mockClear();
    await notificationDispatcher.dispatch(storeId, 'cart_abandoned_step2', {
      ...cartData(phone),
      storeId,
    });
    expect(promoSentTo(phone)).toHaveLength(0);

    // A merchant's token on the storefront API is not a customer.
    const admin = await request(app)
      .get('/api/v1/auth/me/sms-consent')
      .set({ ...as(shopper.id), 'x-test-role': 'store_admin' });
    expect(admin.status).toBe(403);

    // No grant on a store that cannot send promotional SMS.
    const offStore = await seedStore({ sms: false });
    const legacy = await withRlsBypass(tx =>
      tx.user.create({
        data: {
          email: `smsc-legacy-${uid()}@example.test`,
          passwordHash: 'x',
          role: 'customer',
          firstName: 'L',
          lastName: 'G',
          phone: egMobile(),
        },
      })
    );
    const unavailable = await request(app)
      .put('/api/v1/auth/me/sms-consent')
      .set({ 'x-test-user': legacy.id, 'x-store-id': offStore })
      .send({ optIn: true });
    expect(unavailable.status).toBe(409);
    expect(unavailable.body.error.code).toBe('SMS_MARKETING_UNAVAILABLE');
  });

  it('GDPR: export includes consent, erasure deletes it (own + guest rows for the same phone)', async () => {
    const storeId = await seedStore();
    const phone = egMobile();
    const shopper = await seedCustomer(storeId, phone);
    await SmsConsentService.recordGrant(storeId, {
      customerKey: shopper.id,
      userId: shopper.id,
      phone,
      source: 'account',
    });
    await SmsConsentService.recordGrant(storeId, {
      customerKey: shopper.email.toLowerCase(),
      phone: `+20${phone.slice(1)}`,
      source: 'checkout',
    });
    const bystander = egMobile();
    await SmsConsentService.recordGrant(storeId, {
      customerKey: bystander,
      phone: bystander,
      source: 'checkout',
    });

    const bundle = await AuthService.exportAccount(shopper.id);
    expect(bundle.smsMarketingConsents).toHaveLength(1);
    expect(bundle.smsMarketingConsents[0]).toMatchObject({
      storeId,
      granted: true,
      grantedSource: 'account',
    });

    await AuthService.eraseAccount(shopper.id, { actorId: 'system' });
    const left = await withRlsBypass(tx =>
      tx.smsMarketingConsent.findMany({ where: { storeId }, select: { customerKey: true } })
    );
    expect(left.map(r => r.customerKey)).toEqual([bystander]);
  });

  it('admin: customer profile and list rows carry the consent status', async () => {
    const storeId = await seedStore();
    const phone = egMobile();
    const key = `list-${uid()}@example.test`;
    await SmsConsentService.recordGrant(storeId, { customerKey: key, phone, source: 'checkout' });
    const view = await SmsConsentService.getForCustomerKey(storeId, key);
    expect(view).toMatchObject({ status: 'granted', grantedSource: 'checkout' });
    expect(view.grantedAt).toBeInstanceOf(Date);
    const map = await SmsConsentService.statusForKeys(storeId, [
      { key, phone },
      { key: 'nobody', phone: null },
    ]);
    expect(map.get(key)).toBe('granted');
    expect(map.get('nobody')).toBeUndefined();
    // The same key in another store is a different customer.
    expect((await SmsConsentService.getForCustomerKey(await seedStore(), key)).status).toBe('none');
    expect(await prisma.smsMarketingConsent.count({ where: { storeId } })).toBe(1);
  });

  it('a guest opt-in shows on the account the same phone registers later, and its withdraw button works (issue 2423)', async () => {
    const storeId = await seedStore();
    const phone = egMobile();
    // Checkout as a guest: the row is keyed by the guest's email.
    const guestKey = `guest-${uid()}@example.test`;
    await SmsConsentService.recordGrant(storeId, {
      customerKey: guestKey,
      phone: `+20${phone.slice(1)}`,
      source: 'checkout',
    });
    // The same person registers: customerKeyOf is now the user id.
    const shopper = await seedCustomer(storeId, phone);
    const app = buildApp();
    const as = { 'x-test-user': shopper.id, 'x-store-id': storeId };

    // The gate sends to this phone…
    await notificationDispatcher.dispatch(storeId, 'cart_abandoned_step1', {
      ...cartData(phone),
      storeId,
    });
    expect(promoSentTo(phone)).toHaveLength(1);

    // …so every surface must say so: the account page (which renders the
    // "Stop SMS offers" button only for `granted`), the admin profile and the
    // admin list row.
    const page = await request(app).get('/api/v1/auth/me/sms-consent').set(as);
    expect(page.body.data.consent).toMatchObject({ status: 'granted', grantedSource: 'checkout' });
    expect((await SmsConsentService.getForCustomerKey(storeId, shopper.id, phone)).status).toBe(
      'granted'
    );
    const list = await SmsConsentService.statusForKeys(storeId, [{ key: shopper.id, phone }]);
    expect(list.get(shopper.id)).toBe('granted');

    // The button withdraws what the gate reads.
    const stop = await request(app)
      .put('/api/v1/auth/me/sms-consent')
      .set(as)
      .send({ optIn: false });
    expect(stop.body.data.consent).toMatchObject({ status: 'revoked', revokedSource: 'account' });
    enqueue.mockClear();
    await notificationDispatcher.dispatch(storeId, 'cart_abandoned_step2', {
      ...cartData(phone),
      storeId,
    });
    expect(promoSentTo(phone)).toHaveLength(0);
    expect(
      (await SmsConsentService.statusForKeys(storeId, [{ key: shopper.id, phone }])).get(shopper.id)
    ).toBe('revoked');
  });

  it("a later grant on another key for the same phone outranks the account's own withdrawn row", async () => {
    const storeId = await seedStore();
    const phone = egMobile();
    const shopper = await seedCustomer(storeId, phone);
    await SmsConsentService.recordGrant(storeId, {
      customerKey: shopper.id,
      userId: shopper.id,
      phone,
      source: 'account',
    });
    await SmsConsentService.revoke(storeId, { phone, userId: shopper.id }, 'account');
    // Ticks the box again at a guest checkout with the same number.
    await SmsConsentService.recordGrant(storeId, {
      customerKey: `again-${uid()}@example.test`,
      phone,
      source: 'checkout',
    });
    expect(await SmsConsentService.findActiveForPhone(storeId, phone)).not.toBeNull();
    expect((await SmsConsentService.getForCustomerKey(storeId, shopper.id, phone)).status).toBe(
      'granted'
    );
    // Without the phone the read is the key row alone — what it used to be.
    expect((await SmsConsentService.getForCustomerKey(storeId, shopper.id)).status).toBe('revoked');
  });

  it('the opt-out link reads the store once per fan-out, not once per recipient (issue 2426)', async () => {
    __clearOptOutBaseCacheForTests();
    const storeId = await seedStore();
    const [p1, p2] = [egMobile(), egMobile()];
    for (const p of [p1, p2]) {
      await SmsConsentService.recordGrant(storeId, {
        customerKey: p,
        phone: p,
        source: 'checkout',
      });
    }
    await notificationDispatcher.dispatch(storeId, 'cart_abandoned_step1', {
      ...cartData(p1),
      storeId,
    });
    // The store moves to a custom domain between two sends of one sweep: the
    // second link still uses the base read for the first (bounded-stale, 120s).
    const domain = `smsc-${uid()}.example.test`;
    await withRlsBypass(tx => tx.store.update({ where: { id: storeId }, data: { domain } }));
    await notificationDispatcher.dispatch(storeId, 'cart_abandoned_step1', {
      ...cartData(p2),
      storeId,
    });
    const link = (p: string) => (promoSentTo(p)[0][0] as any).messageText as string;
    // Ebda: a store with no custom domain is served at `https://<slug>.ebda.app`.
    const { slug } = (await withRlsBypass(tx =>
      tx.store.findUnique({ where: { id: storeId }, select: { slug: true } })
    ))!;
    const slugOrigin = storefrontOrigin({ slug });
    expect(link(p1)).toContain(`${slugOrigin}/sms-unsubscribe?t=`);
    expect(link(p2)).toContain(`${slugOrigin}/sms-unsubscribe?t=`);
    expect(link(p2)).not.toContain(domain);

    // Once the cache is cold, the new domain is used.
    __clearOptOutBaseCacheForTests();
    const p3 = egMobile();
    await SmsConsentService.recordGrant(storeId, {
      customerKey: p3,
      phone: p3,
      source: 'checkout',
    });
    await notificationDispatcher.dispatch(storeId, 'cart_abandoned_step1', {
      ...cartData(p3),
      storeId,
    });
    expect(link(p3)).toContain(`https://${domain}/sms-unsubscribe?t=`);
  });
});
