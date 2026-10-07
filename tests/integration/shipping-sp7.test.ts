/**
 * SP7 shipping against a real Postgres with the code under test bound to an `ebda_app` login
 * (strict RLS, no bypass), the real Bosta and Aramex adapters talking to loopback stubs:
 *
 *   - booking: COD in piastres on the shipment, idempotent, InstaPay-awaiting orders never ship
 *   - outage isolation: carrier down -> order untouched, row `creation_failed`, retry books once,
 *     merchant told when a refusal cannot be retried
 *   - Bosta webhook auth by the per-store URL secret (wrong / unknown store = 401), replay no-op
 *   - Aramex tracking is polled across stores (acrossStores) under strict RLS
 *   - credentials are encrypted at rest and never echoed
 *   - COD reconciliation over HTTP: import, idempotent re-import, partial remittances,
 *     unmatched lines, per-store isolation
 *
 * Mutation proofs (each turns the named tests red):
 *   - shipping-carrier.service.ts: remove `assertOrderFulfillable(order)` -> "InstaPay"
 *   - runTrackingCron: use a bare `prisma.shipment.findMany` -> "polls every store"
 *   - shipping-carrier.service.ts processCarrierWebhook: skip `verifyWebhookToken` -> "wrong token"
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  createPrismaClient,
  runInTenantContext,
  runWithRequestDb,
  type AppPrismaClient,
} from '@force/database';
import { config } from '@api/config';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import { serveStub, type ServedStub } from '../stubs/serve';
import { BostaStub, BOSTA_STUB } from '../stubs/bosta-stub';
import { AramexStub, ARAMEX_STUB } from '../stubs/aramex-stub';
import { shippingCarrierService } from '@api/services/shipping-carrier.service';
import { planService } from '@api/services/plan.service';
import { redis } from '@api/services/redis.service';
import { OneSignalService } from '@api/services/onesignal.service';
import { CarrierError } from '@api/services/carriers/types';
import {
  bookShipment,
  handleShipmentCreateFailure,
} from '@api/lib/inngest/functions/shipment-create';
import shippingCarrierRoutes from '@api/routes/shipping-carrier.routes';
import webhookRoutes from '@api/routes/webhook.routes';
import { errorHandler } from '@api/middleware/error-handler';

// Customer / merchant notifications are not under test here (and would run after teardown).
vi.mock('@api/services/notification-dispatcher.service', () => ({
  notificationDispatcher: { dispatch: vi.fn().mockResolvedValue(undefined) },
}));

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const run = crypto.randomUUID().slice(0, 8);

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });
const token = (userId: string) =>
  jwt.sign(
    { userId, email: `${userId}@example.test`, role: 'store_admin', tv: 0 },
    config.jwtSecret,
    {
      expiresIn: '30m',
      issuer: 'force-api',
      audience: 'force-app',
    }
  );
/** Run `fn` the way every production caller does: inside the store's tenant scope. */
const inStore = <T>(storeId: string, fn: () => Promise<T>) =>
  asApp(() => runInTenantContext(storeId, fn));

describe.skipIf(!hasDb)('SP7 shipping (ebda_app, strict RLS)', () => {
  let owner: AppPrismaClient;
  let app: Express;
  const bosta = new BostaStub();
  const aramex = new AramexStub();
  let bostaServer: ServedStub;
  let aramexServer: ServedStub;
  const stores: Array<{ id: string; userId: string; jwt: string }> = [];
  let seq = 0;

  async function mkStore(tag: string) {
    const user = await owner.user.create({
      data: {
        email: `sp7-${tag}-${run}@test.local`,
        passwordHash: 'x',
        firstName: 'S',
        lastName: tag,
        role: 'store_admin',
        emailVerified: true,
      },
    });
    const store = await owner.store.create({
      data: {
        name: `sp7-${tag}-${run}`,
        slug: `sp7-${tag}-${run}`,
        ownerId: user.id,
        status: 'active',
      },
    });
    await planService.assignPlan(store.id, { planCode: 'comped' });
    const s = { id: store.id, userId: user.id, jwt: token(user.id) };
    stores.push(s);
    return s;
  }

  async function mkOrder(
    s: { id: string },
    o: { status?: 'confirmed' | 'awaiting_payment_confirmation' | 'cancelled'; cod?: number } = {}
  ) {
    seq += 1;
    const order = await owner.order.create({
      data: {
        storeId: s.id,
        orderNumber: `SP7-${run}-${seq}`,
        status: o.status ?? 'confirmed',
        paymentStatus: 'unpaid',
        subtotal: o.cod ?? 20_000,
        total: o.cod ?? 20_000,
        shippingAddress: {
          firstName: 'Mona',
          lastName: 'Adel',
          phone: '+201012345678',
          address1: '5 Nile Corniche',
          city: 'Giza',
          state: 'Giza',
          country: 'EG',
        },
        billingAddress: {},
      },
    });
    if (o.cod) {
      await owner.payment.create({
        data: { orderId: order.id, provider: 'cod', status: 'cod_pending', amount: o.cod },
      });
    }
    return order;
  }

  const bostaConfig = (s: { id: string }, extra: Record<string, unknown> = {}) =>
    inStore(s.id, () =>
      shippingCarrierService.upsertCarrierConfig(s.id, 'bosta', {
        enabled: true,
        credentials: { apiKey: BOSTA_STUB.apiKey, businessLocationId: 'LOC1' },
        settings: { pickupCity: 'Cairo', pickupLine1: '12 Tahrir St', ...extra },
      })
    );
  const aramexConfig = (s: { id: string }, codConfirmed = false) =>
    inStore(s.id, () =>
      shippingCarrierService.upsertCarrierConfig(s.id, 'aramex', {
        enabled: true,
        credentials: { ...ARAMEX_STUB.credentials },
        settings: { pickupCity: 'Cairo', codEgpConfirmed: codConfirmed },
      })
    );
  const book = (
    s: { id: string },
    orderId: string,
    carrier?: 'bosta' | 'aramex' | 'manual',
    manual?: any
  ) =>
    inStore(s.id, () =>
      shippingCarrierService.createShipmentForOrder(s.id, orderId, carrier, { manual })
    );
  const shipmentOf = (orderId: string) => owner.shipment.findFirst({ where: { orderId } });

  const http = () => {
    const t = request(app);
    const wrap = (m: 'get' | 'post' | 'put') => (url: string) => t[m](url);
    return { get: wrap('get'), post: wrap('post'), put: wrap('put') };
  };
  const auth = (j: string) => ({ Authorization: `Bearer ${j}` });

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 4 });
    await redis.connect().catch(() => undefined);
    bostaServer = await serveStub(bosta.fetch);
    aramexServer = await serveStub(aramex.fetch);
    process.env.BOSTA_BASE_URL = `${bostaServer.url}/api/v2`;
    process.env.ARAMEX_BASE_URL = `${aramexServer.url}/ShippingAPI.V2`;
    process.env.CARRIER_CALL_TIMEOUT_MS = '1500';
    app = express();
    app.set('trust proxy', true);
    app.use('/api/v1/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);
    app.use(express.json());
    app.use('/api/v1/stores', shippingCarrierRoutes);
    app.use(errorHandler);
  });

  beforeEach(() => {
    bosta.faults.down = null;
    aramex.faults.down = null;
    bosta.rejectAuth = false;
  });

  afterAll(async () => {
    const ids = stores.map(s => s.id);
    await owner.codRemittance
      .deleteMany({ where: { storeId: { in: ids } } })
      .catch(() => undefined);
    await owner.auditLog.deleteMany({ where: { storeId: { in: ids } } }).catch(() => undefined);
    await owner.shipment.deleteMany({ where: { storeId: { in: ids } } }).catch(() => undefined);
    await owner.payment
      .deleteMany({ where: { order: { storeId: { in: ids } } } })
      .catch(() => undefined);
    await owner.order.deleteMany({ where: { storeId: { in: ids } } }).catch(() => undefined);
    await owner.shippingCarrierConfig
      .deleteMany({ where: { storeId: { in: ids } } })
      .catch(() => undefined);
    await owner.store.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    await owner.user
      .deleteMany({ where: { id: { in: stores.map(s => s.userId) } } })
      .catch(() => undefined);
    await owner.$disconnect();
    await redis.disconnect().catch(() => undefined);
    await bostaServer.close();
    await aramexServer.close();
  });

  describe('booking', () => {
    it('books a COD order with Bosta: COD in piastres on the shipment, EGP decimal on the wire, order shipped', async () => {
      const s = await mkStore('cod');
      await bostaConfig(s);
      const o = await mkOrder(s, { cod: 123_45 });
      const sh = await book(s, o.id, 'bosta');
      expect(sh).toMatchObject({ status: 'created', carrier: 'bosta', codAmount: 12_345 });
      expect(sh.trackingNumber).toMatch(/^BST/);
      expect(bosta.parcelByTracking(sh.trackingNumber!)?.codSent).toBe(123.45);
      expect((await owner.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('shipped');
      // the callback URL Bosta was given carries this store's id and its secret
      const cb = bosta.parcelByTracking(sh.trackingNumber!)?.webhookUrl ?? '';
      expect(cb).toContain(`/api/v1/webhooks/shipping/bosta/${s.id}/`);
    });

    it('is idempotent: a second call returns the same shipment and books one parcel', async () => {
      const s = await mkStore('idem');
      await bostaConfig(s);
      const o = await mkOrder(s);
      const before = bosta.parcels.size;
      const [a, b] = await Promise.all([book(s, o.id, 'bosta'), book(s, o.id, 'bosta')]);
      expect(b.id).toBe(a.id);
      expect(bosta.parcels.size).toBe(before + 1);
      expect(await owner.shipment.count({ where: { orderId: o.id } })).toBe(1);
    });

    it('an InstaPay order awaiting confirmation cannot ship: refused before the carrier is called', async () => {
      const s = await mkStore('instapay');
      await bostaConfig(s);
      const o = await mkOrder(s, { status: 'awaiting_payment_confirmation' });
      const calls = bosta.requests.length;
      await expect(book(s, o.id, 'bosta')).rejects.toMatchObject({
        code: 'ORDER_AWAITING_PAYMENT_CONFIRMATION',
      });
      expect(bosta.requests.length).toBe(calls); // no carrier call at all
      expect(await shipmentOf(o.id)).toBeNull();
      // not through the manual carrier either
      await expect(
        book(s, o.id, 'manual', { carrierName: 'Sprint', trackingNumber: 'X1' })
      ).rejects.toMatchObject({ code: 'ORDER_AWAITING_PAYMENT_CONFIRMATION' });
      // nor through the admin route
      const res = await asApp(async () =>
        http()
          .post(`/api/v1/stores/${s.id}/orders/${o.id}/ship`)
          .set(auth(s.jwt))
          .send({ carrier: 'bosta' })
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ORDER_AWAITING_PAYMENT_CONFIRMATION');
      // and the retry job treats it as "not ready", not as a failure
      expect(await asApp(() => bookShipment({ storeId: s.id, orderId: o.id }))).toMatchObject({
        skipped: 'ORDER_AWAITING_PAYMENT_CONFIRMATION',
      });
    });

    it('a cancelled order is refused before the carrier is called too', async () => {
      const s = await mkStore('cancelled');
      await bostaConfig(s);
      const o = await mkOrder(s, { status: 'cancelled' });
      const calls = bosta.requests.length;
      await expect(book(s, o.id, 'bosta')).rejects.toMatchObject({
        code: 'INVALID_STATUS_TRANSITION',
      });
      expect(bosta.requests.length).toBe(calls);
    });

    it('Aramex refuses COD until confirmed in EGP (nothing booked, row says why), ships prepaid, and COD once confirmed', async () => {
      const s = await mkStore('aramex');
      await aramexConfig(s, false);
      const codOrder = await mkOrder(s, { cod: 50_000 });
      const before = aramex.parcels.size;
      await expect(book(s, codOrder.id, 'aramex')).rejects.toMatchObject({
        code: 'COD_NOT_SUPPORTED',
      });
      expect(aramex.parcels.size).toBe(before);
      const failed = await shipmentOf(codOrder.id);
      expect(failed?.status).toBe('creation_failed');
      expect(failed?.error).toMatch(/not confirmed/i);

      const prepaid = await mkOrder(s);
      const ok = await book(s, prepaid.id, 'aramex');
      expect(ok.status).toBe('created');
      expect(aramex.parcels.get(ok.trackingNumber!)?.codCurrency).toBeNull();

      await aramexConfig(s, true);
      const retried = await book(s, codOrder.id, 'aramex'); // the failed row is re-claimed
      expect(retried).toMatchObject({
        id: failed!.id,
        status: 'created',
        codAmount: 50_000,
        error: null,
      });
      const parcel = aramex.parcels.get(retried.trackingNumber!);
      expect(parcel).toMatchObject({ codCurrency: 'EGP', codMinor: 50_000 });
    });

    it('manual carrier: the merchant types the courier and the tracking number', async () => {
      const s = await mkStore('manual');
      const o = await mkOrder(s, { cod: 9_900 });
      const sh = await book(s, o.id, 'manual', { carrierName: 'Sprint', trackingNumber: 'SPR-42' });
      expect(sh).toMatchObject({
        carrier: 'manual',
        carrierName: 'Sprint',
        trackingNumber: 'SPR-42',
        status: 'created',
        codAmount: 9_900,
      });
      await expect(
        book(s, (await mkOrder(s)).id, 'manual', { carrierName: '', trackingNumber: '' })
      ).rejects.toBeInstanceOf(CarrierError);
      // the merchant moves it along
      const res = await asApp(async () =>
        http()
          .post(`/api/v1/stores/${s.id}/shipments/${sh.id}/status`)
          .set(auth(s.jwt))
          .send({ status: 'delivered' })
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.shipment.status).toBe('delivered');
      expect((await owner.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe(
        'delivered'
      );
    });
  });

  describe('outage isolation', () => {
    it('carrier down: the order is untouched, the row is creation_failed, and a retry books exactly once', async () => {
      const s = await mkStore('outage');
      await bostaConfig(s);
      const o = await mkOrder(s);
      bosta.faults.down = 'unavailable';
      const before = bosta.parcels.size;
      await expect(book(s, o.id, 'bosta')).rejects.toMatchObject({ code: 'CARRIER_UNAVAILABLE' });
      expect(bosta.parcels.size).toBe(before);
      expect((await owner.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe(
        'confirmed'
      );
      const row = await shipmentOf(o.id);
      expect(row).toMatchObject({ status: 'creation_failed', createAttempts: 1 });
      expect(row?.error).toBeTruthy();

      // the retry job: an outage is rethrown (Inngest retries) and does not notify yet
      const notify = vi
        .spyOn(OneSignalService, 'notifyAdminsOfShipmentFailure')
        .mockResolvedValue();
      await expect(
        asApp(() => bookShipment({ storeId: s.id, orderId: o.id }))
      ).rejects.toMatchObject({
        code: 'CARRIER_UNAVAILABLE',
      });
      expect(notify).not.toHaveBeenCalled();
      expect((await shipmentOf(o.id))?.createAttempts).toBe(2);

      // the carrier recovers: the next attempt books exactly one parcel on the SAME row
      bosta.faults.down = null;
      const done = await asApp(() => bookShipment({ storeId: s.id, orderId: o.id }));
      expect(done).toMatchObject({ status: 'created' });
      expect(bosta.parcels.size).toBe(before + 1);
      expect(await owner.shipment.count({ where: { orderId: o.id } })).toBe(1);
      expect((await owner.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('shipped');
    });

    it('a refusal retrying cannot fix tells the merchant at once and is not retried', async () => {
      const s = await mkStore('refuse');
      await aramexConfig(s, false);
      const o = await mkOrder(s, { cod: 40_000 });
      const notify = vi
        .spyOn(OneSignalService, 'notifyAdminsOfShipmentFailure')
        .mockResolvedValue();
      const err = await asApp(() =>
        bookShipment({ storeId: s.id, orderId: o.id, carrier: 'aramex' })
      ).catch(e => e);
      expect(err.name).toBe('NonRetriableError');
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ storeId: s.id, orderId: o.id, carrier: 'aramex' })
      );
    });

    it('when the retries run out the merchant is pushed, and the failed booking shows on the order', async () => {
      const s = await mkStore('exhaust');
      await bostaConfig(s);
      const o = await mkOrder(s);
      bosta.faults.down = 'unavailable';
      await book(s, o.id, 'bosta').catch(() => undefined);
      const notify = vi
        .spyOn(OneSignalService, 'notifyAdminsOfShipmentFailure')
        .mockResolvedValue();
      await asApp(() =>
        handleShipmentCreateFailure(
          { storeId: s.id, orderId: o.id },
          new Error('carrier unavailable')
        )
      );
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ orderNumber: o.orderNumber, carrier: 'bosta' })
      );
      const card = await asApp(async () =>
        http().get(`/api/v1/stores/${s.id}/orders/${o.id}/shipment`).set(auth(s.jwt))
      );
      expect(card.status).toBe(200);
      expect(card.body.data.shipment).toMatchObject({ status: 'creation_failed' });
      expect(card.body.data.carriers.map((c: { code: string }) => c.code)).toEqual([
        'bosta',
        'manual',
      ]);
      expect(card.body.data.canBook).toBe(true);
    });
  });

  describe('cancel and label', () => {
    it('a parcel the courier already has is not cancelled (409), unless the merchant forces it; a cancelled one can be re-booked as a new parcel', async () => {
      const s = await mkStore('cancel');
      await bostaConfig(s);
      const o = await mkOrder(s);
      const sh = await book(s, o.id, 'bosta');
      bosta.advance(sh.trackingNumber!, 'picked_up');
      const refuse = await asApp(async () =>
        http().post(`/api/v1/stores/${s.id}/orders/${o.id}/ship/cancel`).set(auth(s.jwt)).send({})
      );
      expect(refuse.status).toBe(409);
      expect(refuse.body.error.code).toBe('SHIPMENT_NOT_CANCELLABLE');
      expect((await shipmentOf(o.id))?.status).toBe('created');
      expect((await owner.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('shipped');

      const forced = await asApp(async () =>
        http()
          .post(`/api/v1/stores/${s.id}/orders/${o.id}/ship/cancel`)
          .set(auth(s.jwt))
          .send({ force: true })
      );
      expect(forced.status).toBe(200);
      expect((await shipmentOf(o.id))?.status).toBe('cancelled');
      expect((await owner.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe(
        'processing'
      );

      // re-booking after a cancel is a NEW parcel (a new reference), on the same row
      const before = bosta.parcels.size;
      const again = await book(s, o.id, 'bosta');
      expect(again.id).toBe(sh.id);
      expect(again.status).toBe('created');
      expect(again.trackingNumber).not.toBe(sh.trackingNumber);
      expect(bosta.parcels.size).toBe(before + 1);
    });

    it('a fresh parcel cancels with the carrier; the label comes back as a PDF', async () => {
      const s = await mkStore('label');
      await bostaConfig(s);
      const o = await mkOrder(s);
      const sh = await book(s, o.id, 'bosta');
      const label = await asApp(async () =>
        http().get(`/api/v1/stores/${s.id}/shipments/${sh.id}/label`).set(auth(s.jwt))
      );
      expect(label.status, JSON.stringify(label.body)).toBe(200);
      expect(Buffer.from(label.body.data.label.pdfBase64, 'base64').toString()).toContain('%PDF');
      const res = await asApp(async () =>
        http().post(`/api/v1/stores/${s.id}/orders/${o.id}/ship/cancel`).set(auth(s.jwt)).send({})
      );
      expect(res.status).toBe(200);
      expect(bosta.parcelByTracking(sh.trackingNumber!)?.state).toBe(48);
    });

    it("another store's admin cannot cancel, label or move this store's shipment", async () => {
      const a = await mkStore('xa');
      const b = await mkStore('xb');
      await bostaConfig(a);
      const o = await mkOrder(a);
      const sh = await book(a, o.id, 'bosta');
      for (const [m, url] of [
        ['get', `/api/v1/stores/${b.id}/shipments/${sh.id}/label`],
        ['post', `/api/v1/stores/${b.id}/orders/${o.id}/ship/cancel`],
        ['post', `/api/v1/stores/${b.id}/shipments/${sh.id}/status`],
      ] as const) {
        const res = await asApp(async () =>
          http()[m](url).set(auth(b.jwt)).send({ status: 'delivered' })
        );
        expect(res.status, url).toBe(404);
      }
      expect((await shipmentOf(o.id))?.status).toBe('created');
    });
  });

  describe('Bosta webhook (secret in the URL)', () => {
    async function booked(tag: string) {
      const s = await mkStore(tag);
      await bostaConfig(s);
      const o = await mkOrder(s);
      const sh = await book(s, o.id, 'bosta');
      const secret = (
        await inStore(s.id, () => shippingCarrierService.getCarrierConfig(s.id, 'bosta'))
      )?.credentials.webhookSecret as string;
      return { s, o, sh, secret };
    }
    const post = (storeId: string, tok: string, body: unknown) =>
      asApp(async () =>
        http()
          .post(`/api/v1/webhooks/shipping/bosta/${storeId}/${tok}`)
          .set('Content-Type', 'application/json')
          .send(JSON.stringify(body))
      );

    it('the right token moves the shipment; a replay is a no-op; an old event does not move it back', async () => {
      const { s, o, sh, secret } = await booked('wh');
      // Ahead of the booking's own `created` entry (stamped now), or the event is stale and ignored.
      const base = Date.now() + 6 * 3_600_000;
      const at = (sec: number) => new Date(base + sec * 1000);
      const body = (status: any, ts: Date) => bosta.webhookBody(sh.trackingNumber!, status, ts);

      expect((await post(s.id, secret, body('out_for_delivery', at(30)))).status).toBe(200);
      expect((await shipmentOf(o.id))?.status).toBe('out_for_delivery');
      const history = () =>
        owner.shipment
          .findFirstOrThrow({ where: { orderId: o.id } })
          .then(r => r.statusHistory as any[]);
      const n = (await history()).length;

      // Bosta retries the same delivery
      expect((await post(s.id, secret, body('out_for_delivery', at(30)))).status).toBe(200);
      expect((await history()).length).toBe(n);

      // a late, older event
      expect((await post(s.id, secret, body('picked_up', at(10)))).status).toBe(200);
      expect((await shipmentOf(o.id))?.status).toBe('out_for_delivery');
      expect((await history()).length).toBe(n + 1);

      // delivered flips the order too
      expect((await post(s.id, secret, body('delivered', at(90)))).status).toBe(200);
      expect((await shipmentOf(o.id))?.status).toBe('delivered');
      expect((await owner.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe(
        'delivered'
      );
    });

    it('a wrong token is 401 and changes nothing', async () => {
      const { s, o, sh, secret } = await booked('whbad');
      const body = bosta.webhookBody(sh.trackingNumber!, 'delivered', new Date());
      for (const bad of ['nope', secret.slice(0, -1), `${secret}0`, secret.toUpperCase(), '0']) {
        expect((await post(s.id, bad, body)).status, bad).toBe(401);
      }
      expect((await shipmentOf(o.id))?.status).toBe('created');
    });

    it("one store's secret does not open another store's shipments, and an unknown store is 401", async () => {
      const a = await booked('wha');
      const b = await booked('whb');
      const body = bosta.webhookBody(a.sh.trackingNumber!, 'delivered', new Date());
      expect((await post(b.s.id, a.secret, body)).status).toBe(401); // A's secret on B's URL
      expect((await post(b.s.id, b.secret, body)).status).toBe(200); // B's secret, A's parcel: not B's
      expect((await shipmentOf(a.o.id))?.status).toBe('created');
      expect((await post(crypto.randomUUID(), a.secret, body)).status).toBe(401);
      expect((await post('not-a-uuid', a.secret, body)).status).toBe(401);
    });

    it('a rotated secret stops the old URL at once', async () => {
      const { s, o, sh, secret } = await booked('whrot');
      await inStore(s.id, () => shippingCarrierService.rotateWebhookSecret(s.id, 'bosta'));
      const body = bosta.webhookBody(sh.trackingNumber!, 'delivered', new Date());
      expect((await post(s.id, secret, body)).status).toBe(401);
      expect((await shipmentOf(o.id))?.status).toBe('created');
    });

    it('a carrier with no webhook (Aramex) has no callback route', async () => {
      const s = await mkStore('whaz');
      const res = await asApp(async () =>
        http().post(`/api/v1/webhooks/shipping/aramex/${s.id}/x`).send({})
      );
      expect(res.status).toBe(404);
    });
  });

  describe('tracking poll across stores (Aramex)', () => {
    it('polls every store under strict RLS and leaves finished and manual shipments alone', async () => {
      const a = await mkStore('pa');
      const b = await mkStore('pb');
      await aramexConfig(a);
      await aramexConfig(b);
      const oa = await mkOrder(a);
      const ob = await mkOrder(b);
      const om = await mkOrder(a);
      const shA = await book(a, oa.id, 'aramex');
      const shB = await book(b, ob.id, 'aramex');
      const shM = await book(a, om.id, 'manual', {
        carrierName: 'Sprint',
        trackingNumber: 'SPR-9',
      });
      aramex.advance(shA.trackingNumber!, 'in_transit');
      aramex.advance(shB.trackingNumber!, 'delivered');
      const requestsBefore = aramex.requests.length;

      await asApp(() => shippingCarrierService.runTrackingCron());

      expect((await shipmentOf(oa.id))?.status).toBe('in_transit');
      expect((await shipmentOf(ob.id))?.status).toBe('delivered');
      expect((await owner.order.findUniqueOrThrow({ where: { id: ob.id } })).status).toBe(
        'delivered'
      );
      expect((await shipmentOf(om.id))?.status).toBe(shM.status); // manual: never polled
      expect((await shipmentOf(oa.id))?.lastPolledAt).not.toBeNull();

      // delivered is finished: the next run does not ask about it again
      const asked = aramex.requests.length - requestsBefore;
      await asApp(() => shippingCarrierService.runTrackingCron());
      const askedTracking = aramex.requests
        .slice(requestsBefore + asked)
        .filter(r => r.path.includes('Tracking'));
      expect(askedTracking.length).toBeLessThanOrEqual(asked); // the delivered one is not polled again
      expect((await shipmentOf(ob.id))?.status).toBe('delivered');
    });

    it('a carrier outage during the poll changes nothing and breaks nothing', async () => {
      const s = await mkStore('pout');
      await aramexConfig(s);
      const o = await mkOrder(s);
      const sh = await book(s, o.id, 'aramex');
      aramex.advance(sh.trackingNumber!, 'in_transit');
      aramex.faults.down = 'unavailable';
      await asApp(() => shippingCarrierService.runTrackingCron());
      expect((await shipmentOf(o.id))?.status).toBe('created');
      aramex.faults.down = null;
      await asApp(() => shippingCarrierService.runTrackingCron());
      expect((await shipmentOf(o.id))?.status).toBe('in_transit');
    });
  });

  describe('credentials', () => {
    it('are encrypted at rest, masked in the API, and the webhook secret is server-managed', async () => {
      const s = await mkStore('creds');
      const put = await asApp(async () =>
        http()
          .put(`/api/v1/stores/${s.id}/shipping-carriers/configs/bosta`)
          .set(auth(s.jwt))
          .send({
            enabled: true,
            credentials: { apiKey: 'plain-bosta-key-123456', webhookSecret: 'attacker-chosen' },
            settings: {},
          })
      );
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      const raw = await owner.shippingCarrierConfig.findFirstOrThrow({
        where: { storeId: s.id, carrier: 'bosta' },
      });
      expect(raw.credentials).not.toContain('plain-bosta-key-123456');
      expect(raw.credentials).not.toContain('attacker-chosen');
      const list = await asApp(async () =>
        http().get(`/api/v1/stores/${s.id}/shipping-carriers/configs`).set(auth(s.jwt))
      );
      const cfg = list.body.data.configs.find((c: { carrier: string }) => c.carrier === 'bosta');
      expect(cfg.credentials.apiKey).toBe('plai' + '*'.repeat(18));
      expect(JSON.stringify(list.body)).not.toContain('plain-bosta-key-123456');
      const real = await inStore(s.id, () =>
        shippingCarrierService.getCarrierConfig(s.id, 'bosta')
      );
      expect(real?.credentials.webhookSecret).toMatch(/^[0-9a-f]{48}$/);
      expect(real?.credentials.webhookSecret).not.toBe('attacker-chosen');

      // saving again keeps the same secret (the URL Bosta already has keeps working)
      await asApp(async () =>
        http()
          .put(`/api/v1/stores/${s.id}/shipping-carriers/configs/bosta`)
          .set(auth(s.jwt))
          .send({ enabled: true, credentials: { apiKey: cfg.credentials.apiKey }, settings: {} })
      );
      const again = await inStore(s.id, () =>
        shippingCarrierService.getCarrierConfig(s.id, 'bosta')
      );
      expect(again?.credentials.webhookSecret).toBe(real?.credentials.webhookSecret);
      expect(again?.credentials.apiKey).toBe('plain-bosta-key-123456');
    });

    it("another store cannot read this store's carrier config", async () => {
      const a = await mkStore('ca');
      const b = await mkStore('cb');
      await bostaConfig(a);
      const res = await asApp(async () =>
        http().get(`/api/v1/stores/${a.id}/shipping-carriers/configs`).set(auth(b.jwt))
      );
      expect([403, 404]).toContain(res.status);
      const own = await asApp(async () =>
        http().get(`/api/v1/stores/${b.id}/shipping-carriers/configs`).set(auth(b.jwt))
      );
      expect(own.body.data.configs).toEqual([]);
    });
  });

  describe('COD reconciliation (ledger)', () => {
    const csv = (rows: string[]) =>
      ['tracking number,collected,fee,net,date,reference', ...rows].join('\n');
    const imp = (s: { id: string; jwt: string }, body: string, carrier = 'bosta') =>
      asApp(async () =>
        http()
          .post(`/api/v1/stores/${s.id}/cod-reconciliation/import`)
          .set(auth(s.jwt))
          .send({ carrier, csv: body })
      );
    const report = (s: { id: string; jwt: string }, q = '') =>
      asApp(async () =>
        http().get(`/api/v1/stores/${s.id}/cod-reconciliation${q}`).set(auth(s.jwt))
      );

    it('imports, matches per shipment to the piastre, flags partials, keeps unmatched lines, and is idempotent', async () => {
      const s = await mkStore('cod1');
      await bostaConfig(s);
      const mk = async (cod: number) => {
        const o = await mkOrder(s, { cod });
        return { o, sh: await book(s, o.id, 'bosta') };
      };
      const settled = await mk(123_45);
      const partial = await mk(600_00);
      const waiting = await mk(50_00);
      const over = await mk(100_00);

      const body = csv([
        `${settled.sh.trackingNumber},123.45,1.23,122.22,2026-10-06,R1`,
        `${partial.sh.trackingNumber},300.00,3.00,297.00,2026-10-06,R2`,
        `${partial.sh.trackingNumber},200.01,2.00,198.01,2026-10-07,R3`,
        `${over.sh.trackingNumber},100.01,1.00,99.01,2026-10-07,R4`,
        `NOT-OURS-1,77.70,0.70,77.00,2026-10-07,R5`,
        `${waiting.sh.trackingNumber},50.00,1.00,48.00,2026-10-07,R6`, // net != gross - fee: rejected
      ]);
      const first = await imp(s, body);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.data).toMatchObject({ inserted: 5, duplicates: 0, unmatched: 1 });
      expect(first.body.data.rejected).toEqual([
        { line: 7, reason: 'net is not collected minus fee' },
      ]);

      // re-uploading the same statement changes nothing
      const second = await imp(s, body);
      expect(second.body.data).toMatchObject({ inserted: 0, duplicates: 5 });

      const rep = await report(s);
      const { summary, rows, unmatched } = rep.body.data;
      const byTracking = Object.fromEntries(rows.map((r: any) => [r.trackingNumber, r.result]));
      expect(byTracking[settled.sh.trackingNumber!]).toMatchObject({
        status: 'settled',
        gross: 12_345,
        fees: 123,
        net: 12_222,
      });
      expect(byTracking[partial.sh.trackingNumber!]).toMatchObject({
        status: 'partial',
        gross: 50_001,
        fees: 500,
        net: 49_501,
        outstanding: 9_999,
        flagged: true,
      });
      expect(byTracking[waiting.sh.trackingNumber!]).toMatchObject({
        status: 'awaiting',
        outstanding: 5_000,
      });
      expect(byTracking[over.sh.trackingNumber!]).toMatchObject({
        status: 'over_remitted',
        over: 1,
      });
      expect(unmatched).toHaveLength(1);
      expect(unmatched[0]).toMatchObject({ trackingNumber: 'NOT-OURS-1', grossAmount: 7_770 });

      expect(summary.owed).toBe(12_345 + 60_000 + 5_000 + 10_000);
      expect(summary.gross).toBe(12_345 + 50_001 + 10_001);
      expect(summary.owed - summary.gross).toBe(summary.outstanding - summary.over);
      expect(summary.gross).toBe(summary.fees + summary.net);
      expect(summary.unmatchedGross).toBe(7_770);
      expect(summary.flaggedShipments).toBe(2);

      // the filter the page offers
      const flagged = await report(s, '?status=flagged');
      expect(flagged.body.data.rows.map((r: any) => r.result.status).sort()).toEqual([
        'over_remitted',
        'partial',
      ]);

      // the missing remittance arrives: the partial settles to the piastre
      await imp(s, csv([`${partial.sh.trackingNumber},99.99,1.00,98.99,2026-10-09,R7`]));
      const after = (await report(s)).body.data.rows.find(
        (r: any) => r.trackingNumber === partial.sh.trackingNumber
      );
      expect(after.result).toMatchObject({
        status: 'settled',
        gross: 60_000,
        fees: 600,
        net: 59_400,
      });
    });

    it('a line imported before its shipment exists matches once the shipment does', async () => {
      const s = await mkStore('cod2');
      await bostaConfig(s);
      const o = await mkOrder(s, { cod: 25_00 });
      const sh = await book(s, o.id, 'bosta');
      // delete the shipment's tracking match path: import under a tracking number we then adopt
      await imp(s, csv([`EARLY-1,25.00,0.25,24.75,2026-10-06,E1`]));
      expect((await report(s)).body.data.unmatched).toHaveLength(1);
      await owner.shipment.update({ where: { id: sh.id }, data: { trackingNumber: 'EARLY-1' } });
      const rep = (await report(s)).body.data;
      expect(rep.unmatched).toHaveLength(0);
      expect(rep.rows[0].result).toMatchObject({
        status: 'settled',
        gross: 2_500,
        fees: 25,
        net: 2_475,
      });
    });

    it('is per store: the same tracking number in another store never matches, and its ledger is invisible', async () => {
      const a = await mkStore('cod3a');
      const b = await mkStore('cod3b');
      await bostaConfig(a);
      const o = await mkOrder(a, { cod: 10_00 });
      const sh = await book(a, o.id, 'bosta');
      await imp(b, csv([`${sh.trackingNumber},10.00,0.10,9.90,2026-10-06,B1`]));
      const repB = (await report(b)).body.data;
      expect(repB.rows).toEqual([]);
      expect(repB.unmatched).toHaveLength(1); // B's own statement line, matching nothing of B's
      const repA = (await report(a)).body.data;
      expect(repA.summary).toMatchObject({ gross: 0, unmatchedLines: 0 });
      expect(repA.rows[0].result.status).toBe('awaiting');
      expect(await owner.codRemittance.count({ where: { storeId: a.id } })).toBe(0);
    });

    it('rejects a statement with no usable header and a carrier it does not know', async () => {
      const s = await mkStore('cod4');
      const bad = await imp(s, 'foo,bar\n1,2');
      expect(bad.body.data).toMatchObject({ inserted: 0, rejected: [{ line: 1 }] });
      const unknown = await imp(s, csv(['T1,1.00,0,1.00,2026-10-06,X']), 'nope');
      expect(unknown.status).toBe(400);
    });
  });
});
