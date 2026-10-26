/**
 * Cart-recovery email against REAL Postgres as `ebda_app` (strict RLS + the code-level tenant
 * guard on): checkout opt-in, detection by effective entitlement, the once-per-cart claim under a
 * concurrent double sweep, the full sweep -> deliver path, the cart-restore copy, and the campaign
 * audience scope. Resend/Inngest are stubbed; everything else (Prisma, RLS, featureService, Redis)
 * is real. Retry-safe: all rows are keyed on a per-RUN suffix and cleaned before and after.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import crypto from 'node:crypto';

const h = vi.hoisted(() => {
  process.env.API_URL = 'https://api.test';
  process.env.CART_RESTORE_SECRET = 'integration-cart-restore-secret';
  process.env.CAMPAIGN_UNSUBSCRIBE_SECRET = 'integration-unsub-secret';
  return {
    send: vi.fn(async (_p?: unknown) => ({ ids: ['evt'] })),
    sendMarketingEmail: vi.fn(async (..._a: unknown[]) => ({ id: 'msg_int' })),
  };
});
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: h.send, createFunction: vi.fn() } }));
vi.mock('@api/services/resend.service', () => ({
  ResendService: { sendMarketingEmail: h.sendMarketingEmail },
  ResendSendError: class extends Error {
    constructor(
      readonly code: string,
      m: string
    ) {
      super(m);
    }
  },
}));
vi.mock('@api/lib/campaign-send-pacer', () => ({ awaitCampaignSendSlot: async () => true }));

import {
  createPrismaClient,
  runWithRequestDb,
  runInTenantContext,
  prisma,
  type AppPrismaClient,
} from '@ebda/database';
import { abandonedCartService } from '@api/services/abandoned-cart.service';
import {
  sweepCartRecoveryEmails,
  deliverCartRecoveryEmail,
} from '@api/services/cart-recovery-email.service';
import {
  recordCartEmailConsent,
  restoreCartIntoSession,
} from '@api/services/cart-email-optin.service';
import { buildCampaignAudience, audienceCount } from '@api/services/campaign.service';
import { signCartRestoreToken, verifyCartRestoreToken } from '@api/lib/cart-restore-token';
import { setAppRoleLogin } from '../helpers/app-role-login';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const PREFIX = 'cre-';
const run = crypto.randomUUID().slice(0, 8);

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn);

let owner: AppPrismaClient;
const ids = {} as { store: string; other: string; product: string; ownerUser: string };

async function cleanup() {
  const stores = `(SELECT id FROM public.stores WHERE slug LIKE '${PREFIX}%')`;
  for (const t of [
    'abandoned_carts',
    'abandoned_cart_configs',
    'cart_items',
    'carts',
    'newsletter_subscribers',
    'store_features',
    'products',
  ]) {
    const col =
      t === 'cart_items'
        ? `cart_id IN (SELECT id FROM public.carts WHERE store_id IN ${stores})`
        : `store_id IN ${stores}`;
    await owner.$executeRawUnsafe(`DELETE FROM public.${t} WHERE ${col}`);
  }
  await owner.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${PREFIX}%'`);
}

async function mkCart(storeId: string, sessionId: string, extra: Record<string, unknown> = {}) {
  const cart = await owner.cart.create({
    data: { storeId, sessionId, lastActivityAt: new Date(Date.now() - 3 * 3600e3), ...extra },
  });
  await owner.cartItem.create({ data: { cartId: cart.id, productId: ids.product, quantity: 2 } });
  return cart;
}

describe.skipIf(!hasDb)('cart-recovery email on real Postgres as ebda_app', () => {
  // Per-TEST token for every email address and cart session: a retry re-runs the body on the same
  // database and must not trip the (store, session) / (store, email) unique indexes.
  let n = '';
  beforeEach(() => {
    n = crypto.randomUUID().slice(0, 8);
  });

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 3, role: 'owner' });
    await setAppRoleLogin(owner, APP_PASSWORD);
    await cleanup();
    const u = await owner.user.create({
      data: {
        email: `${PREFIX}${run}@test.com`,
        passwordHash: 'x',
        firstName: 'C',
        lastName: 'R',
        role: 'store_admin',
      },
    });
    ids.ownerUser = u.id;
    // `professional` (Growth) plan: abandoned_cart comes from the PLAN only - there is NO store_features row.
    const s = await owner.store.create({
      data: {
        slug: `${PREFIX}a-${run}`,
        name: 'Cre A',
        ownerId: u.id,
        status: 'active',
        plan: 'professional',
      },
    });
    const o = await owner.store.create({
      data: {
        slug: `${PREFIX}b-${run}`,
        name: 'Cre B',
        ownerId: u.id,
        status: 'active',
        plan: 'professional',
      },
    });
    ids.store = s.id;
    ids.other = o.id;
    const p = await owner.product.create({
      data: {
        storeId: s.id,
        name: 'Linen shirt',
        slug: `${PREFIX}p-${run}`,
        price: 25000,
        inventory: 50,
        status: 'active',
      },
    });
    ids.product = p.id;
    await owner.abandonedCartConfig.create({
      data: { storeId: s.id, emailEnabled: true, emailDelayMinutes: 60 },
    });
  });

  afterAll(async () => {
    await cleanup();
  });

  it('checkout opt-in under strict RLS: guest cart gets the address + a cart_reminders subscriber; an unsubscribed address is never re-activated', async () => {
    const cart = await mkCart(ids.store, `sess-optin-${n}`);
    const r = await asApp(() =>
      runInTenantContext(ids.store, () =>
        recordCartEmailConsent(ids.store, `sess-optin-${n}`, {
          email: `Guest-${n}@Example.com`,
          consent: true,
          language: 'ar',
        })
      )
    );
    expect(r.status).toBe('opted_in');
    const after = await owner.cart.findUnique({ where: { id: cart.id } });
    expect(after!.guestEmail).toBe(`guest-${n}@example.com`);
    expect(after!.guestEmailConsentAt).toBeInstanceOf(Date);
    const sub = await owner.newsletterSubscriber.findFirst({
      where: { storeId: ids.store, email: `guest-${n}@example.com` },
    });
    expect(sub).toMatchObject({
      source: 'checkout',
      consentScope: 'cart_reminders',
      isActive: true,
      language: 'ar',
    });

    await owner.newsletterSubscriber.update({
      where: { id: sub!.id },
      data: { isActive: false, unsubscribedAt: new Date() },
    });
    const again = await asApp(() =>
      runInTenantContext(ids.store, () =>
        recordCartEmailConsent(ids.store, `sess-optin-${n}`, {
          email: `guest-${n}@example.com`,
          consent: true,
        })
      )
    );
    expect(again.status).toBe('unsubscribed');
    expect(
      (await owner.newsletterSubscriber.findUnique({ where: { id: sub!.id } }))!.isActive
    ).toBe(false);
  });

  it('a store entitled ONLY by its plan baseline is swept; a guest cart with consent becomes an email-only abandoned cart', async () => {
    expect(
      await owner.storeFeature.count({
        where: { storeId: ids.store, featureKey: 'abandoned_cart' },
      })
    ).toBe(0);
    const email = `det-${n}@example.com`;
    await owner.newsletterSubscriber.create({
      data: {
        storeId: ids.store,
        email,
        source: 'checkout',
        consentScope: 'cart_reminders',
        consentAt: new Date(),
      },
    });
    const cart = await mkCart(ids.store, `sess-det-${n}`, {
      guestEmail: email,
      guestEmailConsentAt: new Date(),
    });
    await asApp(() => abandonedCartService.detectNewAbandonments());
    const ac = await owner.abandonedCart.findUnique({ where: { cartId: cart.id } });
    expect(ac).not.toBeNull();
    expect(ac!.customerEmail).toBe(email);
    expect(ac!.nextStepAt).toBeNull(); // guest: no push/SMS sequence
    expect(ac!.cartItemCount).toBe(1);
  });

  it('two concurrent sweeps claim a due cart exactly once and emit exactly one event', async () => {
    const email = `race-${n}@example.com`;
    const cart = await mkCart(ids.store, `sess-race-${n}`, {
      guestEmail: email,
      guestEmailConsentAt: new Date(),
    });
    const ac = await owner.abandonedCart.create({
      data: {
        storeId: ids.store,
        cartId: cart.id,
        customerEmail: email,
        cartTotal: 50000,
        cartItemCount: 1,
        cartItems: [{ productName: 'Linen shirt', productImage: null, price: 25000, quantity: 2 }],
        status: 'pending',
        createdAt: new Date(Date.now() - 30 * 60e3),
      },
    });
    h.send.mockClear();
    // createdAt is 30 min old and delay 60 min => due (extra = 0). Both sweeps race the UPDATE.
    const [a, b] = await asApp(() =>
      Promise.all([sweepCartRecoveryEmails(), sweepCartRecoveryEmails()])
    );
    const events = h.send.mock.calls.filter(
      c => (c[0] as { data: { abandonedCartId: string } }).data.abandonedCartId === ac.id
    );
    expect(events).toHaveLength(1);
    expect(a.claimed + b.claimed).toBeGreaterThanOrEqual(1);
    expect((await owner.abandonedCart.findUnique({ where: { id: ac.id } }))!.emailStatus).toBe(
      'queued'
    );
  });

  it('deliver sends once to the consenting subscriber with a restore link, marks sent, and a second delivery is a noop', async () => {
    const email = `send-${n}@example.com`;
    await owner.newsletterSubscriber.create({
      data: {
        storeId: ids.store,
        email,
        source: 'checkout',
        consentScope: 'cart_reminders',
        consentAt: new Date(),
        language: 'en',
      },
    });
    const cart = await mkCart(ids.store, `sess-send-${n}`, {
      guestEmail: email,
      guestEmailConsentAt: new Date(),
    });
    const ac = await owner.abandonedCart.create({
      data: {
        storeId: ids.store,
        cartId: cart.id,
        customerEmail: email,
        cartTotal: 50000,
        cartItemCount: 1,
        cartItems: [{ productName: 'Linen shirt', productImage: null, price: 25000, quantity: 2 }],
        status: 'pending',
        emailStatus: 'queued',
      },
    });
    h.sendMarketingEmail.mockClear();
    const r1 = await asApp(() => deliverCartRecoveryEmail(ids.store, ac.id));
    expect(r1.outcome).toBe('sent');
    expect(h.sendMarketingEmail).toHaveBeenCalledTimes(1);
    const opts = h.sendMarketingEmail.mock.calls[0][1] as {
      to: string;
      html: string;
      idempotencyKey: string;
    };
    expect(opts.to).toBe(email);
    expect(opts.html).toContain('you opted in to cart reminders');
    const m = /\/cart\?restore=([^"&]+)/.exec(opts.html);
    expect(verifyCartRestoreToken(decodeURIComponent(m![1]))).toEqual({
      storeId: ids.store,
      cartId: cart.id,
    });
    const row = await owner.abandonedCart.findUnique({ where: { id: ac.id } });
    expect(row!.emailStatus).toBe('sent');
    expect(row!.emailSentAt).toBeInstanceOf(Date);
    const r2 = await asApp(() => deliverCartRecoveryEmail(ids.store, ac.id));
    expect(r2.outcome).toBe('noop');
    expect(h.sendMarketingEmail).toHaveBeenCalledTimes(1);
  });

  it('an order that converts the cart before the send stops it (status recovered)', async () => {
    const email = `conv-${n}@example.com`;
    await owner.newsletterSubscriber.create({
      data: { storeId: ids.store, email, source: 'footer' },
    });
    const cart = await mkCart(ids.store, `sess-conv-${n}`);
    const ac = await owner.abandonedCart.create({
      data: {
        storeId: ids.store,
        cartId: cart.id,
        customerEmail: email,
        cartTotal: 1,
        cartItemCount: 1,
        cartItems: [],
        status: 'recovered',
        emailStatus: 'queued',
      },
    });
    h.sendMarketingEmail.mockClear();
    const r = await asApp(() => deliverCartRecoveryEmail(ids.store, ac.id));
    expect(r).toEqual({ outcome: 'skipped', detail: 'recovered' });
    expect(h.sendMarketingEmail).not.toHaveBeenCalled();
  });

  it("restore copies the emailed cart's lines into the visiting session, once, and refuses another store's token", async () => {
    const src = await mkCart(ids.store, `sess-src-${n}`);
    const token = signCartRestoreToken(ids.store, src.id);
    const visit = `sess-visit-${n}`;
    const r1 = await asApp(() =>
      runInTenantContext(ids.store, () => restoreCartIntoSession(ids.store, token, visit))
    );
    expect(r1).toMatchObject({ restored: true });
    const mine = await owner.cart.findFirst({
      where: { storeId: ids.store, sessionId: visit },
      include: { items: true },
    });
    expect(mine!.items).toHaveLength(1);
    expect(mine!.items[0].productId).toBe(ids.product);
    const r2 = await asApp(() =>
      runInTenantContext(ids.store, () => restoreCartIntoSession(ids.store, token, visit))
    );
    expect(r2).toEqual({ restored: true, added: 0 });
    const wrong = await asApp(() =>
      runInTenantContext(ids.other, () => restoreCartIntoSession(ids.other, token, visit))
    );
    expect(wrong.restored).toBe(false);
  });

  it('campaign audience (raw SQL + Prisma) excludes cart_reminders consent', async () => {
    await owner.newsletterSubscriber.create({
      data: { storeId: ids.other, email: `news-${n}@example.com`, source: 'footer' },
    });
    await owner.newsletterSubscriber.create({
      data: {
        storeId: ids.other,
        email: `cart-${n}@example.com`,
        source: 'checkout',
        consentScope: 'cart_reminders',
      },
    });
    const [list, count] = await asApp(() =>
      runInTenantContext(
        ids.other,
        async () =>
          [await buildCampaignAudience(ids.other), await audienceCount(ids.other)] as const
      )
    );
    expect(list.map(a => a.email)).toEqual([`news-${n}@example.com`]);
    expect(count).toBe(1);
  });

  it('the shared Prisma client reaches the DB as ebda_app, not a bypass role', async () => {
    const rows = await asApp(
      () =>
        prisma.$queryRaw<
          { u: string; bypass: boolean }[]
        >`SELECT current_user AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`
    );
    expect(rows[0]).toEqual({ u: 'ebda_app', bypass: false });
  });
});
