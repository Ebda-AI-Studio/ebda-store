/**
 * A demo store (stores.is_demo) refuses every order-creating path: no order row, no order item,
 * no stock movement. Reads `is_demo` under the ebda_app role (strict RLS) too.
 *
 * Paths checked (all funnel through plan-limit.service `assertOrderAllowed`):
 *   OrderService.create          storefront checkout, public routes, MCP order tools
 *   OrderService.createAdminOrder merchant phone/manual orders
 *   payment-links.routes          WhatsApp payment link (calls assertOrderAllowed before any write)
 * A non-demo store is unaffected.
 *
 * Ruling B1-13 (+ plan amendment C13): the showroom also refuses every public write that collects
 * visitor PII (customer register with its storeId, newsletter subscribe, contact form, affiliate
 * apply, push subscribe) with the same 403 DEMO_STORE, writing nothing and sending nothing.
 */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { prisma, withRlsBypass, createPrismaClient, runWithRequestDb } from '@ebda/database';
import paymentLinksRoutes from '@api/routes/payment-links.routes';
import { storeScopeContext } from '@api/middleware/tenant-context';
import { errorHandler } from '@api/middleware/error-handler';
import { config } from '@api/config';
import { AppError } from '@api/middleware/error-handler';
import { OrderService } from '@api/services/order.service';
import { assertOrderAllowed, assertNotDemoStore } from '@api/services/plan-limit.service';
import authRoutes from '@api/routes/auth.routes';
import publicRoutes from '@api/routes/public.routes';
import { publicAffiliateRoutes } from '@api/routes/affiliate.routes';
import { publicNotificationRoutes } from '@api/routes/notification.routes';
import { inngest } from '@api/lib/inngest/client';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import {
  hasDb,
  seedBundleStore,
  seedProduct,
  cartSessionId,
  addItemToCart,
  stockOf,
  DEFAULT_TEST_SHIPPING_ADDRESS,
} from '../helpers/bundle-fixtures';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });

const storeIds: string[] = [];

async function seed(isDemo: boolean) {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const store = await seedBundleStore(suffix);
  storeIds.push(store.storeId);
  if (isDemo) {
    await withRlsBypass(tx =>
      tx.store.update({ where: { id: store.storeId }, data: { isDemo: true } })
    );
  }
  const productId = await seedProduct(store.storeId, `${suffix}-p`, {
    inventory: 10,
    price: 1_000,
  });
  return { ...store, productId, suffix };
}

const counts = (storeId: string) =>
  withRlsBypass(async tx => ({
    orders: await tx.order.count({ where: { storeId } }),
    items: await tx.orderItem.count({ where: { order: { storeId } } }),
  }));

describe.skipIf(!hasDb)('demo store refuses orders', () => {
  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.orderItem.deleteMany({ where: { order: { storeId: { in: storeIds } } } });
      await tx.order.deleteMany({ where: { storeId: { in: storeIds } } });
    });
  });

  it('OrderService.create: 403 DEMO_STORE, no order row, no item row, stock untouched', async () => {
    const s = await seed(true);
    const sessionId = cartSessionId('demo-create');
    await addItemToCart(s.storeId, sessionId, s.productId, 1);

    let thrown: AppError | undefined;
    try {
      await OrderService.create(s.storeId, undefined, sessionId, {
        shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
        paymentMethod: 'paymob',
      });
    } catch (e) {
      thrown = e as AppError;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown?.statusCode).toBe(403);
    expect(thrown?.code).toBe('DEMO_STORE');
    expect(await counts(s.storeId)).toEqual({ orders: 0, items: 0 });
    expect(await stockOf(s.productId)).toBe(10);
  });

  it('OrderService.createAdminOrder: 403 DEMO_STORE and nothing written', async () => {
    const s = await seed(true);
    await expect(
      OrderService.createAdminOrder(
        s.storeId,
        s.ownerId,
        {
          items: [{ productId: s.productId, quantity: 1 }],
          shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
          paymentMethod: 'cod',
        } as never,
        { role: 'store_admin' }
      )
    ).rejects.toMatchObject({ statusCode: 403, code: 'DEMO_STORE' });
    expect(await counts(s.storeId)).toEqual({ orders: 0, items: 0 });
    expect(await stockOf(s.productId)).toBe(10);
  });

  it('WhatsApp payment link (HTTP, ebda_app): 403 DEMO_STORE and nothing written', async () => {
    const s = await seed(true);
    // Everything the route checks BEFORE the order gate is satisfied, so only is_demo refuses.
    await withRlsBypass(async tx => {
      await tx.store.update({ where: { id: s.storeId }, data: { wbsEnabled: true } });
      await tx.storeCredential.upsert({
        where: { storeId: s.storeId },
        create: { storeId: s.storeId, wbsApiKey: 'enc-test-key' },
        update: { wbsApiKey: 'enc-test-key' },
      });
      // WHATSAPP-OFF-1: `whatsapp` is OFF for every store by default, so this
      // store carries the per-store override — otherwise the feature gate (not
      // is_demo) would be the thing refusing.
      await tx.storeFeature.create({
        data: { storeId: s.storeId, featureKey: 'whatsapp', enabled: true },
      });
      await tx.whatsAppTemplate.create({
        data: {
          storeId: s.storeId,
          sourceKey: 'paymentLink',
          language: 'en',
          metaName: 'payment_link',
          category: 'UTILITY',
          body: 'Pay here',
          status: 'approved',
        },
      });
    });
    const owner = await prisma.user.findUniqueOrThrow({
      where: { id: s.ownerId },
      select: { email: true },
    });
    const token = jwt.sign(
      { userId: s.ownerId, email: owner.email, role: 'store_admin', tv: 0 },
      config.jwtSecret,
      { expiresIn: '10m', issuer: 'force-api', audience: 'force-app' }
    );
    const app = express();
    app.use(express.json());
    app.use((_req: Request, res: Response, next: NextFunction) => {
      asApp(
        () =>
          new Promise<void>(resolve => {
            res.once('finish', resolve);
            res.once('close', resolve);
            next();
          })
      ).catch(next);
    });
    app.use('/api/v1/stores/:id/payment-links', storeScopeContext, paymentLinksRoutes);
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/v1/stores/${s.storeId}/payment-links`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ customerPhone: '+201012345678', items: [{ productId: s.productId, quantity: 1 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe('DEMO_STORE');
    expect(await counts(s.storeId)).toEqual({ orders: 0, items: 0 });
    expect(await stockOf(s.productId)).toBe(10);
    const waCustomers = await withRlsBypass(tx =>
      tx.user.count({ where: { storeId: s.storeId, role: 'customer' } })
    );
    expect(waCustomers).toBe(0);
  });

  it('assertOrderAllowed reads is_demo under the ebda_app role (strict RLS)', async () => {
    const s = await seed(true);
    await expect(asApp(() => assertOrderAllowed(s.storeId))).rejects.toMatchObject({
      statusCode: 403,
      code: 'DEMO_STORE',
    });
  });

  it('a non-demo store still takes orders', async () => {
    const s = await seed(false);
    await expect(asApp(() => assertOrderAllowed(s.storeId))).resolves.toBeUndefined();
    const sessionId = cartSessionId('non-demo-create');
    await addItemToCart(s.storeId, sessionId, s.productId, 1);
    const order = await OrderService.create(s.storeId, undefined, sessionId, {
      shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS,
      paymentMethod: 'paymob',
    });
    expect(order.id).toBeTruthy();
    expect((await counts(s.storeId)).orders).toBe(1);
  });

  it('an unknown store id is still STORE_NOT_FOUND, not DEMO_STORE', async () => {
    await expect(
      prisma.$transaction(async () => assertOrderAllowed(crypto.randomUUID()))
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe.skipIf(!hasDb)('demo store refuses visitor PII writes (B1-13)', () => {
  let app: express.Express;
  let demo: Awaited<ReturnType<typeof seed>>;
  let shop: Awaited<ReturnType<typeof seed>>;
  const run = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    demo = await seed(true);
    shop = await seed(false);
    // Both stores carry the features, so on the demo ONLY is_demo can refuse.
    await withRlsBypass(async tx => {
      for (const storeId of [demo.storeId, shop.storeId])
        for (const featureKey of ['affiliate', 'push_notifications'])
          await tx.storeFeature.create({ data: { storeId, featureKey, enabled: true } });
    });
    app = express();
    app.use(express.json());
    app.use('/api/v1/auth', authRoutes);
    app.use('/api/v1/public', publicRoutes);
    app.use('/api/v1/public', publicAffiliateRoutes);
    app.use('/api/v1/public', publicNotificationRoutes);
    app.use(errorHandler);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await withRlsBypass(async tx => {
      const ids = { in: [demo.storeId, shop.storeId] };
      await tx.newsletterSubscriber.deleteMany({ where: { storeId: ids } });
      await tx.affiliate.deleteMany({ where: { storeId: ids } });
      await tx.pushSubscription.deleteMany({ where: { storeId: ids } });
      await tx.user.deleteMany({ where: { storeId: ids, role: 'customer' } });
    });
  });

  const register = (storeId: string, email: string) =>
    request(app).post('/api/v1/auth/register').send({
      email,
      password: 'Demo-store-pass-2026!',
      firstName: 'Mona',
      lastName: 'Adel',
      storeId,
    });
  const newsletter = (storeId: string, email: string) =>
    request(app)
      .post('/api/v1/public/newsletter/subscribe')
      .set('X-Store-ID', storeId)
      .send({ email, language: 'ar', source: 'section' });
  const contact = (storeId: string, email: string) =>
    request(app)
      .post('/api/v1/public/contact')
      .set('X-Store-ID', storeId)
      .send({ name: 'Mona', email, subject: 'Sizes', message: 'Do you have the gown in 40?' });
  const affiliate = (storeId: string, email: string) =>
    request(app).post(`/api/v1/public/${storeId}/affiliates/apply`).send({ name: 'Mona', email });
  const push = (storeId: string, tag: string) =>
    request(app)
      .post(`/api/v1/public/${storeId}/push/subscribe`)
      .send({
        endpoint: `https://push.example.test/${tag}`,
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      });

  const users = (storeId: string, email: string) =>
    withRlsBypass(tx => tx.user.count({ where: { storeId, email } }));
  const subscribers = (storeId: string, email: string) =>
    withRlsBypass(tx => tx.newsletterSubscriber.count({ where: { storeId, email } }));
  const affiliates = (storeId: string) =>
    withRlsBypass(tx => tx.affiliate.count({ where: { storeId } }));
  const pushes = (storeId: string) =>
    withRlsBypass(tx => tx.pushSubscription.count({ where: { storeId } }));

  const expectDemoRefusal = (res: request.Response) => {
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe('DEMO_STORE');
    expect(res.body.error.details).toMatchObject({
      messageAr: 'ده متجر تجريبي — الخاصية دي مقفولة هنا',
      messageEn: 'This is a demo store: this is turned off here',
    });
  };

  it('register with the demo storeId: 403 DEMO_STORE, no user row', async () => {
    const email = `demo-reg-${run()}@example.com`;
    expectDemoRefusal(await register(demo.storeId, email));
    expect(await users(demo.storeId, email)).toBe(0);
  });

  it('newsletter subscribe on the demo: 403 DEMO_STORE, no subscriber row', async () => {
    const email = `demo-nl-${run()}@example.com`;
    expectDemoRefusal(await newsletter(demo.storeId, email));
    expect(await subscribers(demo.storeId, email)).toBe(0);
  });

  it('contact on the demo: 403 DEMO_STORE, nothing queued', async () => {
    const send = vi.spyOn(inngest, 'send');
    send.mockClear();
    expectDemoRefusal(await contact(demo.storeId, `demo-ct-${run()}@example.com`));
    expect(send).not.toHaveBeenCalled();
  });

  it('affiliate apply on the demo: 403 DEMO_STORE (before the feature gate), no affiliate row', async () => {
    expectDemoRefusal(await affiliate(demo.storeId, `demo-af-${run()}@example.com`));
    expect(await affiliates(demo.storeId)).toBe(0);
  });

  it('push subscribe on the demo: 403 DEMO_STORE, no subscription row', async () => {
    expectDemoRefusal(await push(demo.storeId, `demo-${run()}`));
    expect(await pushes(demo.storeId)).toBe(0);
  });

  it('a merchant store takes all five as before', async () => {
    const tag = run();
    const reg = await register(shop.storeId, `shop-reg-${tag}@example.com`);
    expect(reg.status, JSON.stringify(reg.body)).toBe(200);
    expect(await users(shop.storeId, `shop-reg-${tag}@example.com`)).toBe(1);

    const nl = await newsletter(shop.storeId, `shop-nl-${tag}@example.com`);
    expect(nl.status, JSON.stringify(nl.body)).toBe(200);
    expect(await subscribers(shop.storeId, `shop-nl-${tag}@example.com`)).toBe(1);

    const send = vi.spyOn(inngest, 'send');
    send.mockClear();
    const ct = await contact(shop.storeId, `shop-ct-${tag}@example.com`);
    expect(ct.status, JSON.stringify(ct.body)).toBe(200);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ name: 'contact/form.submitted' }));

    const af = await affiliate(shop.storeId, `shop-af-${tag}@example.com`);
    expect(af.body?.error?.code).not.toBe('DEMO_STORE');
    expect(af.status, JSON.stringify(af.body)).toBe(201);

    const ps = await push(shop.storeId, `shop-${tag}`);
    expect(ps.status, JSON.stringify(ps.body)).toBe(201);
    expect(await pushes(shop.storeId)).toBe(1);
  });

  it('contact with no resolvable store keeps today’s behaviour (queued, 200)', async () => {
    const send = vi.spyOn(inngest, 'send');
    send.mockClear();
    const res = await request(app)
      .post('/api/v1/public/contact')
      .send({
        name: 'Mona',
        email: `nostore-${run()}@example.com`,
        subject: 'Hi',
        message: 'Hello',
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('assertNotDemoStore reads is_demo under the ebda_app role (strict RLS)', async () => {
    await expect(asApp(() => assertNotDemoStore(demo.storeId))).rejects.toMatchObject({
      statusCode: 403,
      code: 'DEMO_STORE',
    });
    await expect(asApp(() => assertNotDemoStore(shop.storeId))).resolves.toBeUndefined();
    // An unknown store is not this guard's business: the caller keeps its own not-found path.
    await expect(asApp(() => assertNotDemoStore(crypto.randomUUID()))).resolves.toBeUndefined();
  });
});
