/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { bootstrapMerchant, call, type Merchant } from './merchant-fixture';
import { doAuthOp, doRead, doSetStoreFields } from './do-read';

// Ported from tests/integration/demo-store.test.ts (Postgres, strict RLS, express + service calls) to the built Worker + StoreDO, over HTTP:
// a demo store (stores.is_demo) refuses every order-creating path (storefront checkout, merchant manual order: 403 DEMO_STORE, no order row, no
// item row, stock untouched) and every public write that collects visitor PII (customer register with its storeId, newsletter subscribe, contact,
// affiliate apply, push subscribe, forgot-password / resend-verification with its storeId) with the same 403 + bilingual message, writing nothing;
// a merchant store takes all of them; an unknown store id is a 404, not DEMO_STORE.
// Not ported: the two `assertOrderAllowed` / `assertNotDemoStore` "reads is_demo under the ebda_app role (strict RLS)" cases (Postgres RLS: the DO
// serves the flag from its own database, which every case below reads). Affiliate and push on the MERCHANT store are only asserted to not be
// DEMO_STORE (both are plan-gated and the fixture's trial plan lacks them); the demo refusal on both runs before that gate., and the Inngest / identity-service spies ("nothing queued", "the demo
// owner is never handed to the identity service": the Worker has no in-process hook; the generic-answer half is asserted).
const e = env as unknown as {
  PLATFORM_DB: { prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } } };
};
const DEMO_AR = 'ده متجر تجريبي — الخاصية دي مقفولة هنا';
const DEMO_EN = 'This is a demo store: this is turned off here';
const ADDRESS = {
  firstName: 'Mona',
  lastName: 'Adel',
  address1: '1 Test St',
  city: 'Cairo',
  phone: '+201012345678',
  country: 'EG',
};
let demo: Merchant;
let shop: Merchant;
let demoProduct = '';
let shopProduct = '';
let n = 0;
const tag = () => `${Date.now().toString(36)}${++n}`;

const mkProduct = async (m: Merchant) => {
  const r = await call(`/stores/${m.storeId}/products`, {
    method: 'POST',
    token: m.token,
    body: { name: `Demo ${tag()}`, price: 1000, status: 'active', inventory: 10 },
  });
  expect(r.status, r.text).toBe(201);
  return (r.json.data.product ?? r.json.data).id as string;
};
const orderCount = async (m: Merchant) =>
  (await doRead(m.storeId, 'Order', { where: { storeId: m.storeId } })).length;
const itemCount = async (m: Merchant) => (await doRead(m.storeId, 'OrderItem', {})).length;
const stockOf = async (m: Merchant, id: string) =>
  (await doRead<{ inventory: number }>(m.storeId, 'Product', { where: { id } }))[0]!.inventory;
const shopper = (m: Merchant) => ({ 'x-store-id': m.storeId, 'x-session-id': `sess-${tag()}` });
const checkout = async (m: Merchant, productId: string) => {
  const headers = shopper(m);
  const add = await call('/public/cart/items', {
    method: 'POST',
    headers,
    body: { productId, quantity: 1 },
  });
  expect(add.status, add.text).toBeLessThan(300);
  return call('/public/orders', {
    method: 'POST',
    headers,
    body: {
      paymentMethod: 'cod',
      shippingAddress: { ...ADDRESS, phone: `+2010${String(1_000_000 + n++).padStart(8, '0')}` },
    },
  });
};
const expectDemoRefusal = (res: { status: number; text: string; json: any }) => {
  expect(res.status, res.text).toBe(403);
  expect(res.json.error.code).toBe('DEMO_STORE');
  expect(res.json.error.details).toMatchObject({ messageAr: DEMO_AR, messageEn: DEMO_EN });
};

describe('demo store on the Worker', () => {
  beforeAll(async () => {
    demo = await bootstrapMerchant('dms-demo');
    shop = await bootstrapMerchant('dms-shop');
    demoProduct = await mkProduct(demo);
    shopProduct = await mkProduct(shop);
    await doSetStoreFields(demo.storeId, { isDemo: true });
    // customer accounts live in the store's DO once the store's cutover marker is on (the register path has no Postgres fallback)
    await e.PLATFORM_DB.prepare(
      'INSERT OR REPLACE INTO system_settings (id, key, value) VALUES (?1, ?2, \'{"on":true}\')'
    )
      .bind(`dms-auth-${shop.storeId}`, `customer_auth_cutover.${shop.storeId}`)
      .run();
  }, 120_000);

  describe('refuses orders', () => {
    it('storefront checkout: 403 DEMO_STORE, no order row, no item row, stock untouched', async () => {
      const res = await checkout(demo, demoProduct);
      expect(res.status, res.text).toBe(403);
      expect(res.json.error.code).toBe('DEMO_STORE');
      expect(await orderCount(demo)).toBe(0);
      expect(await itemCount(demo)).toBe(0);
      expect(await stockOf(demo, demoProduct)).toBe(10);
    });

    it('a merchant manual order: 403 DEMO_STORE and nothing written', async () => {
      const res = await call(`/stores/${demo.storeId}/orders/admin`, {
        method: 'POST',
        token: demo.token,
        body: {
          items: [{ productId: demoProduct, quantity: 1 }],
          shippingAddress: ADDRESS,
          paymentMethod: 'cod',
        },
      });
      expect(res.status, res.text).toBe(403);
      expect(res.json.error.code).toBe('DEMO_STORE');
      expect(await orderCount(demo)).toBe(0);
      expect(await stockOf(demo, demoProduct)).toBe(10);
    });

    it('a non-demo store still takes orders', async () => {
      const res = await checkout(shop, shopProduct);
      expect(res.status, res.text).toBeLessThan(300);
      expect(await orderCount(shop)).toBe(1);
      expect(await stockOf(shop, shopProduct)).toBeLessThan(10);
    });

    it('an unknown store id is still a 404, not DEMO_STORE', async () => {
      const res = await call('/public/cart/items', {
        method: 'POST',
        headers: { 'x-store-id': crypto.randomUUID(), 'x-session-id': `sess-${tag()}` },
        body: { productId: demoProduct, quantity: 1 },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.json?.error?.code).not.toBe('DEMO_STORE');
    });
  });

  describe('refuses visitor PII writes (B1-13)', () => {
    const register = (storeId: string, email: string) =>
      call('/auth/register', {
        method: 'POST',
        body: {
          email,
          password: 'Demo-store-pass-2026!',
          firstName: 'Mona',
          lastName: 'Adel',
          storeId,
        },
      });
    const newsletter = (storeId: string, email: string) =>
      call('/public/newsletter/subscribe', {
        method: 'POST',
        headers: { 'x-store-id': storeId },
        body: { email, language: 'ar', source: 'section' },
      });
    const contact = (storeId: string, email: string) =>
      call('/public/contact', {
        method: 'POST',
        headers: { 'x-store-id': storeId },
        body: { name: 'Mona', email, subject: 'Sizes', message: 'Do you have the gown in 40?' },
      });
    const affiliate = (storeId: string, email: string) =>
      call(`/public/${storeId}/affiliates/apply`, {
        method: 'POST',
        body: { name: 'Mona', email },
      });
    const push = (storeId: string, t: string) =>
      call(`/public/${storeId}/push/subscribe`, {
        method: 'POST',
        body: {
          endpoint: `https://push.example.test/${t}`,
          keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
        },
      });
    // customer accounts are `_cauth_users` rows in the DO: a resend for the address finds one ('recent') only if register created it
    const hasAccount = async (m: Merchant, email: string) =>
      JSON.stringify(
        await doAuthOp(m.storeId, 'resendVerification', {
          email,
          tokenHash: 'a'.repeat(64),
          rowId: crypto.randomUUID(),
          expiresAt: Date.now() + 3_600_000,
        })
      ).includes('recent');
    const rows = (m: Merchant, model: string, where: object = {}) =>
      doRead(m.storeId, model, { where: { storeId: m.storeId, ...where } });

    it('register with the demo storeId: 403 DEMO_STORE, no customer row', async () => {
      const email = `demo-reg-${tag()}@example.com`;
      expectDemoRefusal(await register(demo.storeId, email));
      expect(await hasAccount(demo, email)).toBe(false);
    });

    it('newsletter subscribe on the demo: 403 DEMO_STORE, no subscriber row', async () => {
      const email = `demo-nl-${tag()}@example.com`;
      expectDemoRefusal(await newsletter(demo.storeId, email));
      expect(await rows(demo, 'NewsletterSubscriber', { email })).toHaveLength(0);
    });

    it('contact on the demo: 403 DEMO_STORE with its own bilingual message', async () => {
      const res = await contact(demo.storeId, `demo-ct-${tag()}@example.com`);
      expect(res.status, res.text).toBe(403);
      expect(res.json.error.code).toBe('DEMO_STORE');
      expect(res.json.error.details).toMatchObject({
        messageAr: 'ده متجر تجريبي — الرسائل مقفولة',
      });
    });

    it('affiliate apply on the demo: 403 DEMO_STORE (before the feature gate), no affiliate row', async () => {
      expectDemoRefusal(await affiliate(demo.storeId, `demo-af-${tag()}@example.com`));
      expect(await rows(demo, 'Affiliate')).toHaveLength(0);
    });

    it('push subscribe on the demo: 403 DEMO_STORE, no subscription row', async () => {
      expectDemoRefusal(await push(demo.storeId, `demo-${tag()}`));
      expect(await rows(demo, 'PushSubscription')).toHaveLength(0);
    });

    it('a merchant store takes all five as before', async () => {
      const t = tag();
      const reg = await register(shop.storeId, `shop-reg-${t}@example.com`);
      expect(reg.status, reg.text).toBe(200);
      expect(await hasAccount(shop, `shop-reg-${t}@example.com`)).toBe(true);
      const nl = await newsletter(shop.storeId, `shop-nl-${t}@example.com`);
      expect(nl.status, nl.text).toBe(200);
      expect(
        await rows(shop, 'NewsletterSubscriber', { email: `shop-nl-${t}@example.com` })
      ).toHaveLength(1);
      const ct = await contact(shop.storeId, `shop-ct-${t}@example.com`);
      expect(ct.status, ct.text).toBe(200);
      // affiliate and push are plan-gated (the fixture's trial plan lacks them): on the merchant store the answer is the feature gate, never DEMO_STORE
      const af = await affiliate(shop.storeId, `shop-af-${t}@example.com`);
      expect(af.json?.error?.code).not.toBe('DEMO_STORE');
      const ps = await push(shop.storeId, `shop-${t}`);
      expect(ps.json?.error?.code).not.toBe('DEMO_STORE');
    });

    it('forgot-password and resend-verification with the demo storeId: 403 DEMO_STORE', async () => {
      const email = `demo-fp-${tag()}@example.com`;
      expectDemoRefusal(
        await call('/auth/forgot-password', {
          method: 'POST',
          body: { email, storeId: demo.storeId },
        })
      );
      expectDemoRefusal(
        await call('/auth/resend-verification', {
          method: 'POST',
          body: { email, storeId: demo.storeId },
        })
      );
    });

    it('the demo owner gets the generic answers (nothing about the account)', async () => {
      const fp = await call('/auth/forgot-password', {
        method: 'POST',
        body: { email: demo.email },
      });
      expect(fp.status, fp.text).toBe(200);
      expect(fp.json.data.message).toBe(
        'If an account exists with this email, a reset link has been sent.'
      );
      const own = await call('/auth/resend-verification', {
        method: 'POST',
        body: { email: demo.email },
      });
      const unknown = await call('/auth/resend-verification', {
        method: 'POST',
        body: { email: `nobody-${tag()}@example.com` },
      });
      expect(own.status, own.text).toBe(200);
      expect(own.json.data).toEqual(unknown.json.data);
    });
  });
});
