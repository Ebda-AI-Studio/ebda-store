/**
 * SP5 task 2 - self-serve onboarding, end to end against a real Postgres.
 *
 * signup -> verify (token read from the CAPTURED mail; nothing is ever sent
 * outside production) -> login -> create store (inactive, free plan) -> pick a
 * template -> first product -> payment method -> go live -> the store answers
 * at `<slug>.ebda.app` (x-store-domain, as apps/web forwards the Host).
 *
 * Mutation proofs (run by hand, recorded in the commit body):
 *   1. onboarding.routes.ts: drop `requireVerifiedEmail` from POST /store ->
 *      "unverified user can log in but cannot create a store" fails (201).
 *   2. merchant-signup.service.ts: make the existing-address branch return a
 *      different body -> "an existing address gets the byte-identical
 *      response" fails.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { prisma } from '@ebda/database';
import { RETIRED_TEMPLATES } from '@ebda/shared';
import { planService } from '@api/services/plan.service';
import merchantSignupRoutes from '@api/routes/merchant-signup.routes';
import authRoutes from '@api/routes/auth.routes';
import onboardingRoutes from '@api/routes/onboarding.routes';
import setupGuideRoutes from '@api/routes/setup-guide.routes';
import productRoutes from '@api/routes/product.routes';
import publicRoutes from '@api/routes/public.routes';
import storeRoutes from '@api/routes/store.routes';
import { tenantContext, billingRouteContext } from '@api/middleware/tenant-context';
import billingRoutes from '@api/routes/billing.routes';
import { errorHandler } from '@api/middleware/error-handler';
import {
  clearCapturedMail,
  getCapturedMail,
  latestCapturedMailTo,
  tokenFromCapturedMail,
} from '@api/services/platform-mailer';
import { hasDb } from '../helpers/bundle-fixtures';

// Card paths are exercised explicitly; the product default is InstaPay-only.
process.env.BILLING_TRIAL_CARD_MODE = 'card_on_file';
const run = crypto.randomUUID().slice(0, 8);
const PASSWORD = 'Str0ng!Passw0rd';
const emails: string[] = [];
const slugs: string[] = [];

function mkEmail(tag: string) {
  const e = `ob-${tag}-${run}@test.local`;
  emails.push(e);
  return e;
}
function mkSlug(tag: string) {
  const s = `ob-${tag}-${run}`;
  slugs.push(s);
  return s;
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  // Mounted exactly as apps/api/src/routes/index.ts mounts them.
  app.use('/api/v1/auth/merchant', merchantSignupRoutes);
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/onboarding', onboardingRoutes);
  app.use('/api/v1/stores', tenantContext, setupGuideRoutes);
  app.use('/api/v1/stores/:storeId/products', tenantContext, productRoutes);
  app.use('/api/v1/stores/:storeId/billing', billingRouteContext, billingRoutes);
  app.use('/api/v1/stores', storeRoutes);
  app.use('/api/v1/public', publicRoutes);
  app.use(errorHandler);
  return app;
}

describe.skipIf(!hasDb)('self-serve merchant onboarding', () => {
  let app: Express;
  // The fill-time floor and per-domain cap are covered in merchant-signup-abuse.test.ts;
  // this funnel test signs up many `@test.local` addresses back to back.
  process.env.SIGNUP_MIN_FILL_MS = '0';
  process.env.SIGNUP_EMAIL_DOMAIN_DAILY_CAP = '100000';
  // `caps stores per owner` exercises the LIFETIME cap (3); the daily cap has its own suite.
  process.env.STORES_PER_ACCOUNT_PER_DAY = '10';
  const api = () => request(app);

  async function signup(email: string, extra: Record<string, unknown> = {}) {
    // Abuse controls (SP5 task 4): the signed form token the signup form fetches.
    const tok = await api().get('/api/v1/auth/merchant/signup-token');
    return api()
      .post('/api/v1/auth/merchant/signup')
      .send({
        email,
        password: PASSWORD,
        name: 'Mona Hassan',
        // The signup schema requires a phone (already true on main); unique per call.
        phone: `010${crypto.randomInt(10_000_000, 99_999_999)}`,
        formToken: tok.body.data.token,
        acceptedLegal: true,
        ...extra,
      });
  }
  async function verify(email: string) {
    const token = tokenFromCapturedMail(latestCapturedMailTo(email));
    expect(token, 'verification mail captured').toBeTruthy();
    return { token: token!, res: await api().post('/api/v1/auth/verify-email').send({ token }) };
  }
  async function login(email: string) {
    const res = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    return res.body.data.accessToken as string;
  }
  /** Signup funnel: save a card on the stub provider (nothing charged). */
  async function saveCard(jwt: string, storeId: string) {
    const setup = await api()
      .post(`/api/v1/stores/${storeId}/billing/card-setup`)
      .set(bearer(jwt))
      .send({ from: 'onboarding' });
    expect(setup.status).toBe(201);
    const confirm = await api()
      .post(`/api/v1/stores/${storeId}/billing/checkout/stub-confirm`)
      .set(bearer(jwt))
      .send({ merchantOrderId: setup.body.data.billingEventId, outcome: 'success' });
    expect(confirm.status).toBe(200);
  }
  async function verifiedMerchant(tag: string) {
    const email = mkEmail(tag);
    await signup(email);
    await verify(email);
    return { email, jwt: await login(email) };
  }
  const bearer = (jwt: string) => ({ Authorization: `Bearer ${jwt}` });

  async function wipe() {
    const users = await prisma.user.findMany({
      where: { email: { in: emails } },
      select: { id: true },
    });
    await prisma.store.deleteMany({
      where: { OR: [{ slug: { in: slugs } }, { ownerId: { in: users.map(u => u.id) } }] },
    });
    await prisma.verificationToken.deleteMany({ where: { userId: { in: users.map(u => u.id) } } });
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
  }

  beforeAll(() => {
    app = buildApp();
    clearCapturedMail();
  });
  afterAll(wipe);

  describe('signup + email verification', () => {
    it('creates an UNVERIFIED store_admin and mails a 24h single-use token (captured, never sent)', async () => {
      const email = mkEmail('signup');
      const res = await signup(email, { phone: '010 1234 5678', language: 'ar' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { emailVerificationSent: true } });

      const user = await prisma.user.findFirstOrThrow({
        where: { email },
        omit: { passwordHash: false },
      });
      expect(user.role).toBe('store_admin');
      expect(user.emailVerified).toBe(false);
      expect(user.storeId).toBeNull();
      expect(user.phone).toBe('+201012345678'); // normalised E.164
      expect(user.passwordHash).not.toContain(PASSWORD);

      const mail = latestCapturedMailTo(email);
      expect(mail?.subject).toBeTruthy();
      const token = tokenFromCapturedMail(mail)!;
      // The plaintext token is only in the mail; the DB holds its SHA-256.
      const row = await prisma.verificationToken.findFirstOrThrow({ where: { userId: user.id } });
      expect(row.token).not.toBe(token);
      expect(row.token).toBe(crypto.createHash('sha256').update(token).digest('hex'));
      const hours = (row.expiresAt.getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(23.9);
      expect(hours).toBeLessThanOrEqual(24);
    });

    it('rejects a weak password, a bad email and a non-Egyptian phone', async () => {
      expect((await signup(mkEmail('w1'), { password: 'short' })).status).toBe(400);
      expect((await signup('not-an-email')).status).toBe(400);
      expect((await signup(mkEmail('w2'), { phone: '+14155550123' })).status).toBe(400);
      expect((await signup(mkEmail('w3'), { phone: '0123' })).status).toBe(400);
    });

    it('an existing address gets the byte-identical response (no account enumeration)', async () => {
      const email = mkEmail('dup');
      const first = await signup(email);
      await verify(email);
      clearCapturedMail();
      // Different case on purpose: the duplicate check is case-insensitive.
      const second = await signup(email.toUpperCase());
      expect(second.status).toBe(first.status);
      expect(second.body).toEqual(first.body);
      expect(
        await prisma.user.count({ where: { email: { equals: email, mode: 'insensitive' } } })
      ).toBe(1);
      // The rightful owner is told, with no verification link.
      const notice = latestCapturedMailTo(email);
      expect(notice).toBeTruthy();
      expect(tokenFromCapturedMail(notice)).toBeNull();
    });

    it('an expired token is refused and the user stays unverified', async () => {
      const email = mkEmail('expired');
      await signup(email);
      const user = await prisma.user.findFirstOrThrow({ where: { email } });
      await prisma.verificationToken.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const { res } = await verify(email);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TOKEN_EXPIRED');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified).toBe(
        false
      );
    });

    it('a token works once; replaying it is refused', async () => {
      const email = mkEmail('used');
      await signup(email);
      const { token, res } = await verify(email);
      expect(res.status).toBe(200);
      const user = await prisma.user.findFirstOrThrow({ where: { email } });
      expect(user.emailVerified).toBe(true);
      const replay = await api().post('/api/v1/auth/verify-email').send({ token });
      expect(replay.status).toBe(400);
      expect(replay.body.error.code).toBe('TOKEN_INVALID');
    });

    it('a made-up token is refused', async () => {
      const res = await api()
        .post('/api/v1/auth/verify-email')
        .send({ token: 'a'.repeat(64) });
      expect(res.status).toBe(400);
    });

    it('resend answers generically, mails only unverified accounts, and honours a cooldown', async () => {
      const unknown = await api()
        .post('/api/v1/auth/merchant/resend-verification')
        .send({ email: mkEmail('nobody') });
      expect(unknown.status).toBe(200);
      expect(unknown.body.data).toEqual({ emailVerificationSent: true });
      expect(latestCapturedMailTo(emails[emails.length - 1])).toBeUndefined();

      const email = mkEmail('resend');
      await signup(email);
      const before = getCapturedMail().filter(m => m.to === email).length;
      // Inside the 60s cooldown: generic 200, no second mail.
      const again = await api().post('/api/v1/auth/merchant/resend-verification').send({ email });
      expect(again.body).toEqual(unknown.body);
      expect(getCapturedMail().filter(m => m.to === email).length).toBe(before);
      // Past the cooldown: a fresh token is mailed and the old one stops working.
      const oldToken = tokenFromCapturedMail(latestCapturedMailTo(email))!;
      await prisma.verificationToken.updateMany({
        data: { createdAt: new Date(Date.now() - 120_000) },
        where: { user: { email } },
      });
      await api().post('/api/v1/auth/merchant/resend-verification').send({ email });
      expect(getCapturedMail().filter(m => m.to === email).length).toBe(before + 1);
      const newToken = tokenFromCapturedMail(latestCapturedMailTo(email))!;
      expect(newToken).not.toBe(oldToken);
      expect((await api().post('/api/v1/auth/verify-email').send({ token: oldToken })).status).toBe(
        400
      );
      expect((await api().post('/api/v1/auth/verify-email').send({ token: newToken })).status).toBe(
        200
      );
    });
  });

  describe('store creation gate', () => {
    it('an unverified user can log in but cannot create a store', async () => {
      const email = mkEmail('unverified');
      await signup(email);
      const jwt = await login(email); // login itself is allowed
      const res = await api()
        .post('/api/v1/onboarding/store')
        .set(bearer(jwt))
        .send({ name: 'Nope', slug: mkSlug('unverified') });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
      expect(await prisma.store.count({ where: { slug: slugs[slugs.length - 1] } })).toBe(0);
      // ...and once verified the same request succeeds.
      await verify(email);
      const ok = await api()
        .post('/api/v1/onboarding/store')
        .set(bearer(jwt))
        .send({ name: 'Yes', slug: slugs[slugs.length - 1] });
      expect(ok.status).toBe(201);
    });

    it('requires authentication, and a customer account cannot use onboarding', async () => {
      expect(
        (await api().post('/api/v1/onboarding/store').send({ name: 'x', slug: 'abcd' })).status
      ).toBe(401);
      expect((await api().get('/api/v1/onboarding/slug-check?slug=abcd')).status).toBe(401);
      const customer = await prisma.user.create({
        data: {
          email: mkEmail('customer'),
          passwordHash: await (await import('bcryptjs')).hash(PASSWORD, 4),
          firstName: 'C',
          lastName: 'C',
          role: 'customer',
          emailVerified: true,
        },
      });
      const jwt = await login(customer.email);
      const res = await api()
        .post('/api/v1/onboarding/store')
        .set(bearer(jwt))
        .send({ name: 'x', slug: mkSlug('cust') });
      // Ruling S11-1 (#75): a customer token works only for the store it was issued for, from
      // that store's origin; anywhere else it is a dead token (401, same as any other).
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_INVALID');
    });

    it('refuses reserved slugs and taken slugs, and slug-check agrees', async () => {
      const { jwt } = await verifiedMerchant('slugs');
      const taken = mkSlug('taken');
      const first = await api()
        .post('/api/v1/onboarding/store')
        .set(bearer(jwt))
        .send({ name: 'First', slug: taken });
      expect(first.status).toBe(201);

      const check = (slug: string) =>
        api()
          .get(`/api/v1/onboarding/slug-check?slug=${encodeURIComponent(slug)}`)
          .set(bearer(jwt));
      expect((await check('app')).body.data).toMatchObject({
        available: false,
        reason: 'SLUG_RESERVED',
      });
      expect((await check('API')).body.data).toMatchObject({
        available: false,
        reason: 'SLUG_RESERVED',
      });
      expect((await check(taken)).body.data).toMatchObject({
        available: false,
        reason: 'SLUG_TAKEN',
      });
      expect((await check('ab')).body.data).toMatchObject({
        available: false,
        reason: 'SLUG_TOO_SHORT',
      });
      expect((await check('bad_slug')).body.data).toMatchObject({
        available: false,
        reason: 'SLUG_INVALID_CHARS',
      });
      const free = mkSlug('free');
      expect((await check(free)).body.data).toEqual({
        slug: free,
        host: `${free}.ebda.app`,
        available: true,
      });

      const { jwt: jwt2 } = await verifiedMerchant('slugs2');
      const reserved = await api()
        .post('/api/v1/onboarding/store')
        .set(bearer(jwt2))
        .send({ name: 'R', slug: 'app' });
      expect(reserved.status).toBe(400);
      expect(reserved.body.error.code).toBe('SLUG_RESERVED');
      const dup = await api()
        .post('/api/v1/onboarding/store')
        .set(bearer(jwt2))
        .send({ name: 'D', slug: taken });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('SLUG_TAKEN');
    });

    it('caps stores per owner: a Growth-trial owner is refused a 2nd store (402), Business may hold 3, then the lifetime cap', async () => {
      const { jwt } = await verifiedMerchant('cap');
      const make = (i: number) =>
        api()
          .post('/api/v1/onboarding/store')
          .set(bearer(jwt))
          .send({ name: `S${i}`, slug: mkSlug(`cap${i}`) });
      const first = await make(0);
      expect(first.status).toBe(201);

      // Locked pricing: stores are 1 / 1 / 3 and the 14-day trial is Growth (1 store).
      const refused = await make(1);
      expect(refused.status).toBe(402);
      expect(refused.body.error.code).toBe('PLAN_LIMIT_REACHED');
      expect(refused.body.error.details).toMatchObject({
        limitKey: 'maxStores',
        limit: 1,
        used: 1,
      });

      await planService.assignPlan(first.body.data.store.id, { planCode: 'business' });
      for (const i of [1, 2]) {
        const r = await make(i);
        expect(r.status).toBe(201);
        // an extra store rides the Business plan: no second Growth trial
        const sub = await prisma.storeSubscription.findUniqueOrThrow({
          where: { storeId: r.body.data.store.id },
        });
        expect([sub.planCode, sub.status]).toEqual(['business', 'active']);
      }
      const over = await make(3);
      expect(over.status).toBe(409);
      expect(over.body.error.code).toBe('STORE_LIMIT_REACHED');
    });
  });

  describe('signup -> live store -> first product (scripted, no human)', () => {
    it('runs the whole funnel and the store answers at <slug>.ebda.app', async () => {
      const t0 = Date.now();
      const slug = mkSlug('e2e');
      const host = `${slug}.ebda.app`;
      const email = mkEmail('e2e');

      expect((await signup(email, { phone: '01012345678' })).status).toBe(200);
      expect((await verify(email)).res.status).toBe(200);
      const jwt = await login(email);

      // Resume point before any store exists.
      let state = (await api().get('/api/v1/onboarding/state').set(bearer(jwt))).body.data;
      expect(state.user.emailVerified).toBe(true);
      expect(state.store).toBeNull();

      const created = await api()
        .post('/api/v1/onboarding/store')
        .set(bearer(jwt))
        .send({ name: 'متجر منى', slug, language: 'ar' });
      expect(created.status).toBe(201);
      const storeId = created.body.data.store.id as string;

      // Inactive, on the locked 14-day Growth trial (no free plan); COD seeded; NOT reachable yet.
      const row = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
      expect(row.status).toBe('inactive');
      expect(row.plan).toBe('professional');
      const sub = await prisma.storeSubscription.findUniqueOrThrow({ where: { storeId } });
      expect(sub.planCode).toBe('growth');
      expect(sub.status).toBe('trialing');
      const trialDays = (sub.trialEndsAt!.getTime() - Date.now()) / 86_400_000;
      expect(trialDays).toBeGreaterThan(13.9);
      expect(trialDays).toBeLessThanOrEqual(14);
      const hostProducts = () =>
        api().get('/api/v1/public/products?limit=10').set('x-store-domain', host);
      expect((await hostProducts()).status).toBe(400);

      // A merchant restyles through a LOOK: a bare legacy template is refused (#111), and the
      // store started on the registry default look.
      const tpl = await api()
        .put(`/api/v1/stores/${storeId}/look`)
        .set(bearer(jwt))
        .send({ lookId: 'souq.catalogue', design: 'keep' });
      expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
      const bare = await api()
        .put(`/api/v1/stores/${storeId}/template`)
        .set(bearer(jwt))
        .send({ template: RETIRED_TEMPLATES[2] });
      expect(bare.status).toBe(400);

      const product = await api().post(`/api/v1/stores/${storeId}/products`).set(bearer(jwt)).send({
        name: 'Cotton Scarf',
        nameAr: 'إيشارب قطن',
        price: 25000,
        inventory: 10,
        status: 'active',
      });
      expect(product.status).toBe(201);

      const pay = await api()
        .put(`/api/v1/onboarding/stores/${storeId}/payment-methods`)
        .set(bearer(jwt))
        .send({ cod: true });
      expect(pay.status).toBe(200);

      // Signup funnel: no card (and no InstaPay choice) -> the store cannot go live.
      const refused = await api()
        .post(`/api/v1/onboarding/stores/${storeId}/go-live`)
        .set(bearer(jwt));
      expect(refused.status).toBe(402);
      expect(refused.body.error.code).toBe('PAYMENT_METHOD_REQUIRED');
      await saveCard(jwt, storeId);

      const live = await api()
        .post(`/api/v1/onboarding/stores/${storeId}/go-live`)
        .set(bearer(jwt));
      expect(live.status).toBe(200);
      expect(live.body.data.store).toMatchObject({ status: 'active', host });

      const publicList = await hostProducts();
      expect(publicList.status).toBe(200);
      const names = JSON.stringify(publicList.body);
      expect(names).toContain('Cotton Scarf');

      state = (await api().get('/api/v1/onboarding/state').set(bearer(jwt))).body.data;
      expect(state.store).toMatchObject({ status: 'active', planCode: 'growth', host });
      expect(state.productCount).toBe(1);
      expect(state.codEnabled).toBe(true);

      const ms = Date.now() - t0;
      console.log(`[onboarding-e2e] signup -> live store with product in ${ms} ms`);
    });

    it('cannot disable the only payment method, and cannot go live without one', async () => {
      const { jwt } = await verifiedMerchant('nopay');
      const slug = mkSlug('nopay');
      const storeId = (
        await api().post('/api/v1/onboarding/store').set(bearer(jwt)).send({ name: 'NP', slug })
      ).body.data.store.id as string;
      const off = await api()
        .put(`/api/v1/onboarding/stores/${storeId}/payment-methods`)
        .set(bearer(jwt))
        .send({ cod: false });
      expect(off.status).toBe(400);
      expect(off.body.error.code).toBe('NO_PAYMENT_METHOD');
      // Force the invalid state and prove go-live refuses it (billing is secured
      // first, so the refusal below is the storefront-payment check).
      await saveCard(jwt, storeId);
      await prisma.paymentConfig.updateMany({ where: { storeId }, data: { isEnabled: false } });
      const live = await api()
        .post(`/api/v1/onboarding/stores/${storeId}/go-live`)
        .set(bearer(jwt));
      expect(live.status).toBe(400);
      expect((await prisma.store.findUniqueOrThrow({ where: { id: storeId } })).status).toBe(
        'inactive'
      );
    });

    it("one merchant cannot touch another merchant's store", async () => {
      const a = await verifiedMerchant('ta');
      const b = await verifiedMerchant('tb');
      const storeA = (
        await api()
          .post('/api/v1/onboarding/store')
          .set(bearer(a.jwt))
          .send({ name: 'A', slug: mkSlug('ta') })
      ).body.data.store.id as string;
      const attempts = [
        api().post(`/api/v1/onboarding/stores/${storeA}/go-live`),
        api().put(`/api/v1/onboarding/stores/${storeA}/payment-methods`).send({ cod: true }),
        api().get(`/api/v1/stores/${storeA}/setup-guide`),
        api().put(`/api/v1/stores/${storeA}/setup-guide/items/share`).send({ done: true }),
      ];
      for (const req of attempts) {
        const res = await req.set(bearer(b.jwt));
        expect(res.status).toBe(403);
      }
      expect((await prisma.store.findUniqueOrThrow({ where: { id: storeA } })).status).toBe(
        'inactive'
      );
    });
  });

  describe('setup-guide checklist', () => {
    it('auto-completes from real data and persists manual ticks per store', async () => {
      const { jwt } = await verifiedMerchant('guide');
      const storeId = (
        await api()
          .post('/api/v1/onboarding/store')
          .set(bearer(jwt))
          .send({ name: 'G', slug: mkSlug('guide') })
      ).body.data.store.id as string;
      const guide = async () =>
        (await api().get(`/api/v1/stores/${storeId}/setup-guide`).set(bearer(jwt))).body.data;
      const done = (g: { items: { key: string; done: boolean }[] }, key: string) =>
        g.items.find(i => i.key === key)!.done;

      let g = await guide();
      expect(g.items.map((i: { key: string }) => i.key)).toEqual([
        'add_product',
        'brand',
        'shipping',
        'payment',
        'domain',
        'test_order',
        'share',
      ]);
      // A new store always starts on a look (#111), and a look IS a brand palette (LOOKS-14), so
      // "brand" is done from the start and nothing else is.
      expect(done(g, 'brand')).toBe(true);
      expect(g.doneCount).toBe(1);
      // The rest of this flow proves the LEGACY brand signals (logo / colour), so take the look off.
      await prisma.store.update({ where: { id: storeId }, data: { look: null } });
      g = await guide();
      expect(done(g, 'brand')).toBe(false);
      expect(g.doneCount).toBe(0);
      // COD is seeded ON but that alone does not tick "payment".
      expect(done(g, 'payment')).toBe(false);

      // add_product: from the product count.
      await api()
        .post(`/api/v1/stores/${storeId}/products`)
        .set(bearer(jwt))
        .send({ name: 'P', price: 1000, inventory: 1 });
      g = await guide();
      expect(done(g, 'add_product')).toBe(true);
      expect(g.items.find((i: { key: string }) => i.key === 'add_product').fromData).toBe(true);

      // brand: logo or colour.
      await prisma.store.update({
        where: { id: storeId },
        data: { logo: 'https://cdn.test/logo.png' },
      });
      expect(done(await guide(), 'brand')).toBe(true);

      // shipping: from zones.
      await prisma.shippingZone.create({ data: { storeId, name: 'Cairo', deliveryFee: 5000 } });
      expect(done(await guide(), 'shipping')).toBe(true);

      // domain: from the store's custom domain.
      await prisma.store.update({
        where: { id: storeId },
        data: { domain: `shop-${run}.example.com` },
      });
      expect(done(await guide(), 'domain')).toBe(true);

      // manual: share. Persisted on the store (survives a fresh read).
      expect(done(await guide(), 'share')).toBe(false);
      const tick = await api()
        .put(`/api/v1/stores/${storeId}/setup-guide/items/share`)
        .set(bearer(jwt))
        .send({ done: true });
      expect(tick.status).toBe(200);
      expect(done(await guide(), 'share')).toBe(true);
      const settings = (await prisma.store.findUniqueOrThrow({ where: { id: storeId } }))
        .settings as Record<string, unknown>;
      expect(settings.setupGuide).toMatchObject({ manual: { share: true } });
      expect(settings.defaultLanguage).toBe('ar'); // sibling keys not clobbered

      // data-derived items cannot be ticked by hand.
      const auto = await api()
        .put(`/api/v1/stores/${storeId}/setup-guide/items/add_product`)
        .set(bearer(jwt))
        .send({ done: false });
      expect(auto.status).toBe(400);
      expect(auto.body.error.code).toBe('AUTO_GUIDE_ITEM');
      expect(
        (
          await api()
            .put(`/api/v1/stores/${storeId}/setup-guide/items/bogus`)
            .set(bearer(jwt))
            .send({ done: true })
        ).status
      ).toBe(400);

      // dismiss persists.
      await api()
        .put(`/api/v1/stores/${storeId}/setup-guide/dismissed`)
        .set(bearer(jwt))
        .send({ dismissed: true });
      expect((await guide()).dismissed).toBe(true);
      // ...without losing the manual tick.
      expect(done(await guide(), 'share')).toBe(true);
    });
  });
});
