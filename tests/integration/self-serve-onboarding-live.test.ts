/**
 * SP5 task 2 - the unaided E2E, over real HTTP against a running API.
 *
 * Same funnel as self-serve-onboarding.test.ts, but through the booted server
 * (CI runs it as the non-bypass `ebda_app` role, so every step is also proven
 * under enforced RLS): signup -> verify -> login -> create store -> template ->
 * product -> payment -> go live -> the storefront answers at `<slug>.ebda.app`
 * (x-store-domain) with the product -> setup guide reflects it.
 *
 * Since Stage 3 (Rulings ID-1/ID-2) signup, the verification mail and sign-in belong to the identity service, which the Node
 * integration server has no Service Binding to. So this file asserts the Store contract for signup (a documented 503
 * IDENTITY_UNAVAILABLE that creates nothing), then seeds the merchant row directly and presents the ES256 token the identity
 * service would issue (tests/helpers/identity-session.ts); the signup/verification/sign-in engines are covered by
 * apps/accounts/test/identity.test.ts and rpc.test.ts. Everything from "create store" onward runs over real HTTP as before.
 *
 * Requires the API on TEST_API_URL (default http://localhost:4000).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '@ebda/database';
import { defaultNewStoreLook } from '@ebda/shared';
import { API_BASE } from '../helpers/api-base';
import { hasDb } from '../helpers/bundle-fixtures';
import { mintIdentityToken } from '../helpers/identity-session';

const run = crypto.randomUUID().slice(0, 8);
const email = `live-ob-${run}@test.local`;
const slug = `live-ob-${run}`;
const PASSWORD = 'Str0ng!Passw0rd';

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; jwt?: string; host?: string } = {}
) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.jwt ? { authorization: `Bearer ${opts.jwt}` } : {}),
      ...(opts.host ? { 'x-store-domain': opts.host } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    data?: any;
    error?: { code: string };
  } | null;
  return { status: res.status, body: json };
}

describe.skipIf(!hasDb)('self-serve onboarding over HTTP (ebda_app)', () => {
  beforeAll(async () => {
    const health = await fetch(API_BASE.replace(/\/api\/v1$/, '/health')).catch(() => null);
    if (!health?.ok) throw new Error(`API not reachable at ${API_BASE}`);
  });
  afterAll(async () => {
    const user = await prisma.user.findFirst({ where: { email } });
    await prisma.store.deleteMany({ where: { slug } });
    if (user) {
      await prisma.verificationToken.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it('signup -> verify -> store -> product -> live, no human', async () => {
    const t0 = Date.now();

    // Abuse controls (SP5 task 4): a server-signed form token, held past the
    // minimum fill time, exactly as the signup form does.
    const tokenRes = await call('GET', '/auth/merchant/signup-token');
    expect(tokenRes.status).toBe(200);
    await new Promise(r => setTimeout(r, 3200));
    const signup = await call('POST', '/auth/merchant/signup', {
      body: {
        email,
        password: PASSWORD,
        name: 'Live Merchant',
        phone: '012 3456 7890',
        formToken: tokenRes.body!.data.token,
        acceptedLegal: true,
      },
    });
    // The Node server has no ACCOUNTS binding: signup is the documented fail-closed 503 and creates no account.
    expect(signup.status).toBe(503);
    expect(signup.body?.error?.code).toBe('IDENTITY_UNAVAILABLE');
    expect(await prisma.user.count({ where: { email } })).toBe(0);

    // The merchant as the identity service + shadow reconcile would leave them: an UNVERIFIED profile row.
    const merchant = await prisma.user.create({
      data: {
        email,
        passwordHash: '!identity',
        firstName: 'Live',
        lastName: 'Merchant',
        role: 'store_admin',
        emailVerified: false,
      },
    });
    const tokenFor = (emailVerified: boolean) =>
      mintIdentityToken({ userId: merchant.id, email, emailVerified });
    // The Store's own password login is closed for it (the identity service signs it in).
    const early = await call('POST', '/auth/login', { body: { email, password: PASSWORD } });
    expect(early.status).toBe(401);

    // Before verification: a session exists, but no store can be created.
    const denied = await call('POST', '/onboarding/store', {
      jwt: await tokenFor(false),
      body: { name: 'Early', slug },
    });
    expect(denied.status).toBe(403);
    expect(denied.body?.error?.code).toBe('EMAIL_NOT_VERIFIED');

    // Verified at the identity service; the shadow row follows at the next sign-in.
    await prisma.user.update({ where: { id: merchant.id }, data: { emailVerified: true } });
    const jwt = await tokenFor(true);

    const created = await call('POST', '/onboarding/store', {
      jwt,
      body: { name: 'متجر تجريبي', slug, language: 'ar' },
    });
    expect(created.status).toBe(201);
    const storeId = created.body!.data.store.id as string;

    const host = `${slug}.ebda.app`;
    expect((await call('GET', '/public/products?limit=5', { host })).status).toBe(400); // not live yet

    // Picking a style is now `applyLook` onto a BUILT look; a bare-skin switch is closed
    // (Ruling B1-17, StoreService.updateTemplate -> 400 INVALID_TEMPLATE).
    expect(
      (
        await call('PUT', `/stores/${storeId}/look`, {
          jwt,
          body: { lookId: defaultNewStoreLook().id, design: 'reset' },
        })
      ).status
    ).toBe(200);
    const product = await call('POST', `/stores/${storeId}/products`, {
      jwt,
      body: { name: 'Live Scarf', price: 19900, inventory: 5, status: 'active' },
    });
    expect(product.status).toBe(201);
    expect(
      (
        await call('PUT', `/onboarding/stores/${storeId}/payment-methods`, {
          jwt,
          body: { cod: true },
        })
      ).status
    ).toBe(200);
    // Billing gate (Ruling EBDA-FUNNEL-5): the 14-day trial needs a card or InstaPay chosen before go-live.
    // Nothing is charged; InstaPay needs EBDA_INSTAPAY_HANDLE on the API server (ci.yml sets it).
    const refused = await call('POST', `/onboarding/stores/${storeId}/go-live`, { jwt });
    expect(refused.status).toBe(402);
    expect(refused.body?.error?.code).toBe('PAYMENT_METHOD_REQUIRED');
    expect(
      (
        await call('POST', `/stores/${storeId}/billing/payment-method`, {
          jwt,
          body: { method: 'instapay' },
        })
      ).status
    ).toBe(200);
    const live = await call('POST', `/onboarding/stores/${storeId}/go-live`, { jwt });
    expect(live.status).toBe(200);
    expect(live.body!.data.store).toMatchObject({ status: 'active', host });

    const pub = await call('GET', '/public/products?limit=5', { host });
    expect(pub.status).toBe(200);
    expect(JSON.stringify(pub.body)).toContain('Live Scarf');

    const guide = await call('GET', `/stores/${storeId}/setup-guide`, { jwt });
    expect(guide.status).toBe(200);
    const item = (k: string) => guide.body!.data.items.find((i: { key: string }) => i.key === k);
    expect(item('add_product').done).toBe(true);
    expect(item('payment').done).toBe(true);
    expect(item('test_order').done).toBe(false);

    console.log(`[onboarding-live-e2e] signup -> live storefront in ${Date.now() - t0} ms`);
  });
});
