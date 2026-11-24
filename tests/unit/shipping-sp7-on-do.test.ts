/**
 * SP7 shipping on the Durable Object + platform D1 (ported from tests/integration/shipping-sp7.test.ts, which ran against a live
 * relational database with an `ebda_app` login): the real Bosta and Aramex adapters talking to loopback stubs, the real shipping
 * router, webhook router, tracking cron, booking job and COD reconciliation, on one StoreDO schema PER STORE (real money ops for the
 * orders and COD payments) with the directory and access gate on the platform D1.
 *
 *   - booking: COD in piastres on the shipment, idempotent, InstaPay-awaiting and cancelled orders never ship, Aramex COD gate, manual;
 *   - outage isolation: carrier down -> order untouched, row `creation_failed`, retry books once, merchant told on refusal;
 *   - cancel / label, and another store's admin refused;
 *   - Bosta webhook auth by the per-store URL secret AND the derived header (wrong token / header / unknown store = 401), replay no-op;
 *   - Aramex tracking polled across stores (a store list from D1, each store's rows from its own DO);
 *   - COD reconciliation over HTTP: import, idempotent re-import, partial remittances, unmatched lines, per-store isolation.
 * The credentials block of the original (write-only, encrypted, webhook secret server-managed, other store refused) is covered
 * one-for-one by tests/unit/shipping-carrier-connect-routes-on-do.test.ts ("saves ... write-only", "refuses unknown credential keys",
 * "tenant scoping").
 *
 * Mutation proofs (each turns the named tests red):
 *   - shipping-carrier.service.ts: remove `assertOrderFulfillable(order)` -> "InstaPay";
 *   - processCarrierWebhook: skip `verifyWebhookToken` -> "wrong token"; skip the `impl.webhookHeader` check -> "missing or wrong header";
 *   - runTrackingCron: list only one store -> "polls every store".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

process.env.ENCRYPTION_KEY = '0'.repeat(64);

const h = vi.hoisted(() => ({
  audit: [] as Array<Record<string, unknown>>,
  accounts: new Map<string, { role: string; email: string }>(),
  withStoreRepo: (_id: string, fn: () => unknown): unknown => fn(),
  currentStoreId: (): string | undefined => undefined,
}));

vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  // No tenant transaction on the platform D1 or a DO: a scope is the store's repo scope, as in production after the cutover.
  return {
    ...real,
    withStore: (id: string, fn: (tx: unknown) => unknown) =>
      h.withStoreRepo(id, () => fn(real.prisma)),
    withUser: (_u: string, fn: (tx: unknown) => unknown) => fn(real.prisma),
    runInTenantContext: (_i: unknown, fn: () => unknown) => fn(),
    runInStoreScope: (id: string, fn: () => unknown) => h.withStoreRepo(id, fn),
    acrossStoresFlat: async (
      fn: (id: string) => Promise<unknown[]>,
      o?: { storeIds?: string[] }
    ) => {
      const out: unknown[] = [];
      for (const id of o?.storeIds ?? [])
        out.push(...((await h.withStoreRepo(id, () => fn(id))) as unknown[]));
      return out;
    },
    runInUserScope: (_u: string, fn: () => unknown) => fn(),
    currentStoreId: () => h.currentStoreId(),
  };
});
vi.mock('@api/lib/identity-client', async importOriginal => ({
  ...(await importOriginal<object>()),
  getAccountState: async (id: string) => {
    const a = h.accounts.get(id);
    return a
      ? { id, role: a.role, status: 'active', email: a.email, firstName: 'T', lastName: 'U' }
      : null;
  },
  getAccountsBrief: async (ids: string[]) =>
    ids.flatMap(id => (h.accounts.has(id) ? [{ id, email: h.accounts.get(id)!.email }] : [])),
}));
vi.mock('@api/middleware/auth', async importOriginal => ({
  ...(await importOriginal<object>()),
  // identity comes from a header; authorize / rejectImpersonated stay real
  authenticate: (req: any, res: any, n: () => void) => {
    const id = String(req.headers['x-test-user']);
    const a = h.accounts.get(id);
    if (!a) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
    req.user = { userId: id, email: a.email, role: a.role };
    n();
  },
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: unknown, _s: unknown, n: () => void) => n(),
}));
vi.mock('@api/middleware/feature-gate', async importOriginal => ({
  ...(await importOriginal<object>()),
  requireFeature: () => (_q: unknown, _s: unknown, n: () => void) => n(),
}));
vi.mock('@api/middleware/tenant-context', async importOriginal => {
  const pass = (_q: unknown, _s: unknown, n: () => void) => n();
  return {
    ...(await importOriginal<object>()),
    tenantContext: pass,
    paymentSettingsRouteContext: pass,
    shippingCarrierRouteContext: pass,
  };
});
vi.mock('@api/middleware/security', async importOriginal => ({
  ...(await importOriginal<object>()),
  auditLog: async (e: Record<string, unknown>) => void h.audit.push(e),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import shippingCarrierRoutes from '@api/routes/shipping-carrier.routes';
import webhookRoutes from '@api/routes/webhook.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { shippingCarrierService } from '@api/services/shipping-carrier.service';
import { OneSignalService } from '@api/services/onesignal.service';
import { CarrierError } from '@api/services/carriers/types';
import { webhookHeaderValue } from '@api/services/carriers/bosta.carrier';
import {
  bookShipment,
  handleShipmentCreateFailure,
} from '@api/lib/inngest/functions/shipment-create';
import { BostaStub, BOSTA_STUB } from '../stubs/bosta-stub';
import { AramexStub, ARAMEX_STUB } from '../stubs/aramex-stub';
import { serveStub, type ServedStub } from '../stubs/serve';
import { DoStores } from '../helpers/multi-store-do';
import { insertSqlite } from '../../packages/repo/test/diff-harness';
import { installPlatformD1, uninstallPlatformD1 } from '../helpers/platform-d1-rig';

// Customer / merchant notifications are not under test here.
vi.mock('@api/services/notification-dispatcher.service', () => ({
  notificationDispatcher: { dispatch: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    send: vi.fn(async () => undefined),
    createFunction: (o: unknown, f: unknown) => ({ options: o, handler: f }),
  },
}));
vi.mock('@api/lib/event-after-commit', () => ({
  sendEventAfterCommit: vi.fn(async () => undefined),
}));

const worlds = new DoStores();
h.withStoreRepo = (id, fn) => worlds.withStoreRepo(id, fn);
h.currentStoreId = () => worlds.currentStoreId();
let d1: DatabaseSync;
let app: Express;
let seq = 0;
const bosta = new BostaStub();
const aramex = new AramexStub();
let bostaServer: ServedStub;
let aramexServer: ServedStub;
const storeOfOrder = new Map<string, string>();

// the header-driven identity IS the "jwt" of an actor
type Actor = { id: string; userId: string; email: string; jwt: string };
function account(role: string, tag: string): { userId: string; email: string } {
  const userId = crypto.randomUUID();
  const email = `${tag}-${userId.slice(0, 6)}@test.local`;
  h.accounts.set(userId, { role, email });
  return { userId, email };
}
async function mkStore(tag: string): Promise<Actor> {
  const u = account('store_admin', `owner-${tag}`);
  const id = crypto.randomUUID();
  const slug = `sp7-${tag}-${id.slice(0, 6)}`;
  d1.prepare(
    `INSERT INTO stores (id, name, slug, owner_id, status) VALUES (?, ?, ?, ?, 'active')`
  ).run(id, `sp7-${tag}`, slug, u.userId);
  const w = worlds.add(id, { money: true });
  w.seedProfile({ name: `sp7-${tag}`, slug, ownerId: u.userId });
  w.sqlite.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status, cost_price) VALUES ('p1', '${id}', 'Widget', 'widget', 1000, 100000, 'active', 400)`
  );
  return { id, ...u, jwt: u.userId };
}

/** A confirmed order with a COD payment of exactly `cod` piastres (or no payment at all when `cod` is unset). */
async function mkOrder(
  s: { id: string },
  o: { status?: 'confirmed' | 'awaiting_payment_confirmation' | 'cancelled'; cod?: number } = {}
) {
  seq += 1;
  const w = worlds.get(s.id);
  const created = await w.money!.createOrder({
    lines: [{ productId: 'p1', quantity: 1 }],
    shippingAddress: {
      firstName: 'Mona',
      lastName: 'Adel',
      phone: `+2010123${String(seq).padStart(5, '0')}`,
      // Aramex requires a consignee email; Bosta needs the district of the delivery address
      email: 'mona.adel@example.test',
      address1: '5 Nile Corniche',
      city: 'Giza',
      state: 'Giza',
      area: 'Dokki',
      country: 'EG',
    },
    paymentMethod: 'cod',
  } as never);
  const id = created.orderId;
  await w.money!.orderStatus({ orderId: id, status: 'confirmed' });
  const total = o.cod ?? 20_000;
  w.sqlite.prepare('UPDATE orders SET subtotal = ?, total = ? WHERE id = ?').run(total, total, id);
  w.sqlite.prepare('DELETE FROM payments WHERE order_id = ?').run(id);
  if (o.cod)
    insertSqlite(w.sqlite, 'Payment', [
      {
        id: crypto.randomUUID(),
        orderId: id,
        provider: 'cod',
        status: 'cod_pending',
        amount: o.cod,
      },
    ]);
  if (o.status && o.status !== 'confirmed')
    w.sqlite.prepare('UPDATE orders SET status = ? WHERE id = ?').run(o.status, id);
  storeOfOrder.set(id, s.id);
  const orderNumber = (w.rows('SELECT order_number FROM orders WHERE id = ?', id)[0] as any)
    .order_number as string;
  return { id, orderNumber };
}
const worldOfOrder = (orderId: string) => worlds.get(storeOfOrder.get(orderId)!);
const orderStatus = (orderId: string) =>
  (worldOfOrder(orderId).rows('SELECT status FROM orders WHERE id = ?', orderId)[0] as any)
    .status as string;
const shipCount = (orderId: string) =>
  worldOfOrder(orderId).rows('SELECT id FROM shipments WHERE order_id = ?', orderId).length;
const shipmentOf = async (orderId: string) =>
  (await worldOfOrder(orderId).repo.db.shipment.findFirst({ where: { orderId } })) as Record<
    string,
    any
  > | null;

// the identity header is the whole "auth" of this suite
const asApp = <T>(fn: () => Promise<T>) => fn();
const auth = (j: string) => ({ 'x-test-user': j });
const http = () => {
  const t = request(app);
  const wrap = (m: 'get' | 'post' | 'put') => (url: string) => t[m](url);
  return { get: wrap('get'), post: wrap('post'), put: wrap('put') };
};

/**
 * Connect a carrier the way a merchant does (the stub is reached through the BOSTA_BASE_URL / ARAMEX_BASE_URL overrides, so a
 * sandbox-mode key hits it): save the sandbox credentials, Test connection, enable. A row that already exists only gets its
 * settings replaced.
 */
const connectCarrier = async (
  s: { id: string },
  carrier: 'bosta' | 'aramex',
  fields: Record<string, string>,
  settings: Record<string, unknown>
) => {
  const exists = await worlds.withStoreRepo(s.id, () =>
    shippingCarrierService.getCarrierConfig(s.id, carrier)
  );
  if (exists) {
    return worlds.withStoreRepo(s.id, () =>
      shippingCarrierService.upsertCarrierConfig(s.id, carrier, { settings })
    );
  }
  await worlds.withStoreRepo(s.id, () =>
    shippingCarrierService.upsertCarrierConfig(s.id, carrier, {
      credentials: { mode: 'sandbox', fields },
      activate: true,
      settings,
    })
  );
  const t = await worlds.withStoreRepo(s.id, () =>
    shippingCarrierService.testConnection(s.id, carrier)
  );
  expect(t.test.ok, JSON.stringify(t.test)).toBe(true);
  return worlds.withStoreRepo(s.id, () =>
    shippingCarrierService.upsertCarrierConfig(s.id, carrier, { enabled: true })
  );
};
const bostaConfig = (s: { id: string }, extra: Record<string, unknown> = {}) =>
  connectCarrier(
    s,
    'bosta',
    { apiKey: BOSTA_STUB.apiKey, businessLocationId: 'LOC1' },
    { pickupCity: 'Cairo', pickupLine1: '12 Tahrir St', ...extra }
  );
const aramexConfig = (s: { id: string }, codConfirmed = false) =>
  connectCarrier(
    s,
    'aramex',
    { ...ARAMEX_STUB.credentials },
    { pickupCity: 'Cairo', productType: 'CDS', codEgpConfirmed: codConfirmed }
  );
const book = (
  s: { id: string },
  orderId: string,
  carrier?: 'bosta' | 'aramex' | 'manual',
  manual?: any
) =>
  worlds.withStoreRepo(s.id, () =>
    shippingCarrierService.createShipmentForOrder(s.id, orderId, carrier, { manual })
  );

beforeAll(async () => {
  d1 = installPlatformD1();
  bostaServer = await serveStub(bosta.fetch);
  aramexServer = await serveStub(aramex.fetch);
  process.env.BOSTA_BASE_URL = `${bostaServer.url}/api/v2`;
  process.env.ARAMEX_BASE_URL = `${aramexServer.url}/ShippingAPI.V2`;
  process.env.CARRIER_CALL_TIMEOUT_MS = '1500';
  app = express();
  app.set('trust proxy', true);
  app.use(worlds.repoByPath());
  app.use('/api/v1/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);
  app.use(express.json());
  app.use('/api/v1/stores', shippingCarrierRoutes);
  app.use(errorHandler);
});
beforeEach(() => {
  bosta.faults.down = null;
  aramex.faults.down = null;
  bosta.rejectAuth = false;
  h.audit.length = 0;
});
afterAll(async () => {
  await bostaServer.close();
  await aramexServer.close();
  delete process.env.BOSTA_BASE_URL;
  delete process.env.ARAMEX_BASE_URL;
  delete process.env.CARRIER_CALL_TIMEOUT_MS;
  uninstallPlatformD1();
});

describe('SP7 shipping on the DO (platform D1 directory, one StoreDO per store)', () => {
  describe('booking', () => {
    it('books a COD order with Bosta: COD in piastres on the shipment, EGP decimal on the wire, order shipped', async () => {
      const s = await mkStore('cod');
      await bostaConfig(s);
      const o = await mkOrder(s, { cod: 123_45 });
      const sh = await book(s, o.id, 'bosta');
      expect(sh).toMatchObject({ status: 'created', carrier: 'bosta', codAmount: 12_345 });
      expect(sh.trackingNumber).toMatch(/^\d+$/);
      // Bosta's carrierShipmentId is the tracking number; its own _id is the transaction id
      expect(sh.carrierShipmentId).toBe(sh.trackingNumber);
      expect(sh.carrierTransactionId).toBe(bosta.parcelByTracking(sh.trackingNumber!)?.id);
      expect(bosta.parcelByTracking(sh.trackingNumber!)?.codSent).toBe(123.45);
      expect(orderStatus(o.id)).toBe('shipped');
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
      expect(shipCount(o.id)).toBe(1);
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
      expect(
        await worlds.withStoreRepo(s.id, () => bookShipment({ storeId: s.id, orderId: o.id }))
      ).toMatchObject({
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

    it('an unverified carrier books once connected and enabled (PROVIDERS-3), in production mode too', async () => {
      const s = await mkStore('unverified');
      await bostaConfig(s); // enabled + tested
      const o = await mkOrder(s);
      const prev = process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED;
      delete process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED; // run as production does
      try {
        expect((await book(s, o.id, 'bosta')).status).toBe('created');
      } finally {
        process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED = prev;
      }
      expect((await shipmentOf(o.id))?.status).toBe('created');
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
      expect(orderStatus(o.id)).toBe('delivered');
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
      expect(orderStatus(o.id)).toBe('confirmed');
      const row = await shipmentOf(o.id);
      expect(row).toMatchObject({ status: 'creation_failed', createAttempts: 1 });
      expect(row?.error).toBeTruthy();

      // the retry job: an outage is rethrown (Inngest retries) and does not notify yet
      const notify = vi
        .spyOn(OneSignalService, 'notifyAdminsOfShipmentFailure')
        .mockResolvedValue();
      await expect(
        worlds.withStoreRepo(s.id, () => bookShipment({ storeId: s.id, orderId: o.id }))
      ).rejects.toMatchObject({
        code: 'CARRIER_UNAVAILABLE',
      });
      expect(notify).not.toHaveBeenCalled();
      expect((await shipmentOf(o.id))?.createAttempts).toBe(2);

      // the carrier recovers: the next attempt books exactly one parcel on the SAME row
      bosta.faults.down = null;
      const done = await worlds.withStoreRepo(s.id, () =>
        bookShipment({ storeId: s.id, orderId: o.id })
      );
      expect(done).toMatchObject({ status: 'created' });
      expect(bosta.parcels.size).toBe(before + 1);
      expect(shipCount(o.id)).toBe(1);
      expect(orderStatus(o.id)).toBe('shipped');
    });

    it('a refusal retrying cannot fix tells the merchant at once and is not retried', async () => {
      const s = await mkStore('refuse');
      await aramexConfig(s, false);
      const o = await mkOrder(s, { cod: 40_000 });
      const notify = vi
        .spyOn(OneSignalService, 'notifyAdminsOfShipmentFailure')
        .mockResolvedValue();
      const err = await worlds
        .withStoreRepo(s.id, () =>
          bookShipment({ storeId: s.id, orderId: o.id, carrier: 'aramex' })
        )
        .catch(e => e);
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
      await worlds.withStoreRepo(s.id, () =>
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
      expect(orderStatus(o.id)).toBe('shipped');

      const forced = await asApp(async () =>
        http()
          .post(`/api/v1/stores/${s.id}/orders/${o.id}/ship/cancel`)
          .set(auth(s.jwt))
          .send({ force: true })
      );
      expect(forced.status).toBe(200);
      expect((await shipmentOf(o.id))?.status).toBe('cancelled');
      expect(orderStatus(o.id)).toBe('processing');

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

  describe('Bosta webhook (secret in the URL + derived header)', () => {
    async function booked(tag: string) {
      const s = await mkStore(tag);
      await bostaConfig(s);
      const o = await mkOrder(s);
      const sh = await book(s, o.id, 'bosta');
      const secret = (
        await worlds.withStoreRepo(s.id, () =>
          shippingCarrierService.getCarrierConfig(s.id, 'bosta')
        )
      )?.credentials.webhookSecret as string;
      // exactly what Bosta echoes back: the custom header the adapter registered at create
      const hdr = bosta.webhookHeaders(sh.trackingNumber!);
      return { s, o, sh, secret, hdr };
    }
    const post = (
      storeId: string,
      tok: string,
      body: unknown,
      headers: Record<string, string> = {}
    ) =>
      asApp(async () =>
        http()
          .post(`/api/v1/webhooks/shipping/bosta/${storeId}/${tok}`)
          .set('Content-Type', 'application/json')
          .set(headers)
          .send(JSON.stringify(body))
      );

    it('the header Bosta is given is derived from the secret, never the secret itself', async () => {
      const { secret, hdr } = await booked('whhdr');
      expect(hdr).toEqual({ 'x-ebda-webhook-secret': webhookHeaderValue(secret) });
      expect(Object.values(hdr)[0]).not.toBe(secret);
    });

    it('the right token and header move the shipment; a replay is a no-op; an old event does not move it back', async () => {
      const { s, o, sh, secret, hdr } = await booked('wh');
      // Ahead of the booking's own `created` entry (stamped now), or the event is stale and ignored.
      const base = Date.now() + 6 * 3_600_000;
      const at = (sec: number) => new Date(base + sec * 1000);
      const body = (status: any, ts: Date) => bosta.webhookBody(sh.trackingNumber!, status, ts);

      expect((await post(s.id, secret, body('out_for_delivery', at(30)), hdr)).status).toBe(200);
      expect((await shipmentOf(o.id))?.status).toBe('out_for_delivery');
      const history = () => shipmentOf(o.id).then(r => r!.statusHistory as any[]);
      const n = (await history()).length;

      // Bosta retries the same delivery
      expect((await post(s.id, secret, body('out_for_delivery', at(30)), hdr)).status).toBe(200);
      expect((await history()).length).toBe(n);

      // a late, older event
      expect((await post(s.id, secret, body('picked_up', at(10)), hdr)).status).toBe(200);
      expect((await shipmentOf(o.id))?.status).toBe('out_for_delivery');
      expect((await history()).length).toBe(n + 1);

      // delivered flips the order too
      expect((await post(s.id, secret, body('delivered', at(90)), hdr)).status).toBe(200);
      expect((await shipmentOf(o.id))?.status).toBe('delivered');
      expect(orderStatus(o.id)).toBe('delivered');
    });

    it('a wrong token is 401 and changes nothing (even with the right header)', async () => {
      const { s, o, sh, secret, hdr } = await booked('whbad');
      const body = bosta.webhookBody(sh.trackingNumber!, 'delivered', new Date());
      for (const bad of ['nope', secret.slice(0, -1), `${secret}0`, secret.toUpperCase(), '0']) {
        expect((await post(s.id, bad, body, hdr)).status, bad).toBe(401);
      }
      expect((await shipmentOf(o.id))?.status).toBe('created');
    });

    it('a missing or wrong header is 401 and changes nothing (the URL token alone is not enough)', async () => {
      const { s, o, sh, secret, hdr } = await booked('whhdr2');
      const other = await booked('whhdr3');
      const name = Object.keys(hdr)[0];
      const body = bosta.webhookBody(sh.trackingNumber!, 'delivered', new Date(Date.now() + 9e6));
      const bad: Array<[string, Record<string, string>]> = [
        ['no header', {}],
        ['empty header', { [name]: '' }],
        ['the raw secret instead of the derived value', { [name]: secret }],
        ['a truncated value', { [name]: hdr[name].slice(0, -1) }],
        ['an uppercased value', { [name]: hdr[name].toUpperCase() }],
        ["another store's header value", other.hdr],
        ['the right value under another name', { 'x-other': hdr[name] }],
      ];
      for (const [label, h] of bad) {
        expect((await post(s.id, secret, body, h)).status, label).toBe(401);
      }
      expect((await shipmentOf(o.id))?.status).toBe('created');
      // the same request with the real header is accepted
      expect((await post(s.id, secret, body, hdr)).status).toBe(200);
      expect((await shipmentOf(o.id))?.status).toBe('delivered');
    });

    it("one store's secret does not open another store's shipments, and an unknown store is 401", async () => {
      const a = await booked('wha');
      const b = await booked('whb');
      const body = bosta.webhookBody(a.sh.trackingNumber!, 'delivered', new Date());
      expect((await post(b.s.id, a.secret, body, a.hdr)).status).toBe(401); // A's secret on B's URL
      expect((await post(b.s.id, a.secret, body, b.hdr)).status).toBe(401); // A's token, B's header
      expect((await post(b.s.id, b.secret, body, a.hdr)).status).toBe(401); // B's token, A's header
      expect((await post(b.s.id, b.secret, body, b.hdr)).status).toBe(200); // B's secret, A's parcel: not B's
      expect((await shipmentOf(a.o.id))?.status).toBe('created');
      expect((await post(crypto.randomUUID(), a.secret, body, a.hdr)).status).toBe(401);
      expect((await post('not-a-uuid', a.secret, body, a.hdr)).status).toBe(401);
    });

    it('a rotated secret stops the old URL and header at once, and the new pair works', async () => {
      const { s, o, sh, secret, hdr } = await booked('whrot');
      await worlds.withStoreRepo(s.id, () =>
        shippingCarrierService.rotateWebhookSecret(s.id, 'bosta')
      );
      const body = bosta.webhookBody(sh.trackingNumber!, 'delivered', new Date(Date.now() + 9e6));
      expect((await post(s.id, secret, body, hdr)).status).toBe(401);
      const fresh = (
        await worlds.withStoreRepo(s.id, () =>
          shippingCarrierService.getCarrierConfig(s.id, 'bosta')
        )
      )?.credentials.webhookSecret as string;
      expect(fresh).not.toBe(secret);
      // the new token with the OLD header is still refused: the header is derived from the secret
      expect((await post(s.id, fresh, body, hdr)).status).toBe(401);
      expect((await shipmentOf(o.id))?.status).toBe('created');
      const newHdr = { 'x-ebda-webhook-secret': webhookHeaderValue(fresh) };
      expect((await post(s.id, fresh, body, newHdr)).status).toBe(200);
      expect((await shipmentOf(o.id))?.status).toBe('delivered');
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
      expect(orderStatus(ob.id)).toBe('delivered');
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
      worlds
        .get(s.id)
        .sqlite.prepare('UPDATE shipments SET tracking_number = ? WHERE id = ?')
        .run('EARLY-1', sh.id);
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
      expect(worlds.get(a.id).rows('SELECT id FROM cod_remittances')).toHaveLength(0);
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
