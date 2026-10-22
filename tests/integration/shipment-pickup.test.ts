/**
 * PROVIDERS-18 courier pickups against a real Postgres with the code under test bound to an
 * `ebda_app` login (strict RLS), the real Bosta and Aramex adapters talking to loopback stubs
 * that follow their official specs. No real carrier is called; no real pickup is booked.
 *
 *   - request over the admin route: the row, the carrier call, the panel state
 *   - IDEMPOTENT: a replayed key, a second request while one is live and two concurrent
 *     requests are each ONE carrier pickup
 *   - cancel where the carrier allows it (Bosta DELETE, Aramex CancelPickup), audit-logged
 *   - a carrier outage leaves a `failed` row that says the pickup MAY exist; a new request works
 *   - refusals before any call: ShipBlu (automatic), a delivered shipment, a date out of range,
 *     an Aramex request without a window; another store sees nothing (RLS)
 *
 * Mutation proofs (2026-10-08, each restored byte-identical): drop the claim's race recovery
 * (`if (winner) return ...`) -> "idempotent" goes red; drop the partial index
 * `shipment_pickups_one_active` -> "idempotent" goes red (two carrier pickups). Removing ONLY
 * the in-code replay / live-pickup lookups is NOT caught, by design: they are the fast path in
 * front of the two UNIQUE indexes, which are the guard.
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
} from '@ebda/database';
import { config } from '@api/config';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import { serveStub, type ServedStub } from '../stubs/serve';
import { BostaStub, BOSTA_STUB } from '../stubs/bosta-stub';
import { AramexStub, ARAMEX_STUB } from '../stubs/aramex-stub';
import { shippingCarrierService } from '@api/services/shipping-carrier.service';
import { requestPickup } from '@api/services/shipment-pickup.service';
import { cairoToday } from '@api/services/carriers/pickup-time';
import { planService } from '@api/services/plan.service';
import { redis } from '@api/services/redis.service';
import shippingCarrierRoutes from '@api/routes/shipping-carrier.routes';
import { errorHandler } from '@api/middleware/error-handler';

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
    { expiresIn: '30m', issuer: 'ebda-api', audience: 'ebda-app' }
  );
const inStore = <T>(storeId: string, fn: () => Promise<T>) =>
  asApp(() => runInTenantContext(storeId, fn));
const key = () => crypto.randomUUID();
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

describe.skipIf(!hasDb)('PROVIDERS-18 shipment pickups (ebda_app, strict RLS)', () => {
  let owner: AppPrismaClient;
  let app: Express;
  const bosta = new BostaStub();
  const aramex = new AramexStub();
  let bostaServer: ServedStub;
  let aramexServer: ServedStub;
  const stores: Array<{ id: string; userId: string; jwt: string }> = [];
  let seq = 0;
  const tomorrow = () => addDays(cairoToday(), 1);

  async function mkStore(tag: string) {
    const user = await owner.user.create({
      data: {
        email: `pu-${tag}-${run}@test.local`,
        passwordHash: 'x',
        firstName: 'P',
        lastName: tag,
        role: 'store_admin',
        emailVerified: true,
      },
    });
    const store = await owner.store.create({
      data: {
        name: `pu-${tag}-${run}`,
        slug: `pu-${tag}-${run}`,
        ownerId: user.id,
        status: 'active',
      },
    });
    await planService.assignPlan(store.id, { planCode: 'comped' });
    const s = { id: store.id, userId: user.id, jwt: token(user.id) };
    stores.push(s);
    return s;
  }

  async function mkOrder(s: { id: string }) {
    seq += 1;
    return owner.order.create({
      data: {
        storeId: s.id,
        orderNumber: `PU-${run}-${seq}`,
        status: 'confirmed',
        paymentStatus: 'paid',
        subtotal: 20_000,
        total: 20_000,
        shippingAddress: {
          firstName: 'Mona',
          lastName: 'Adel',
          phone: '+201012345678',
          address1: '5 Nile Corniche',
          city: 'Giza',
          state: 'Giza',
          area: 'Dokki',
          country: 'EG',
        },
        billingAddress: {},
      },
    });
  }

  const connect = async (
    s: { id: string },
    carrier: 'bosta' | 'aramex',
    fields: Record<string, string>,
    settings: Record<string, unknown>
  ) => {
    await inStore(s.id, () =>
      shippingCarrierService.upsertCarrierConfig(s.id, carrier, {
        credentials: { mode: 'sandbox', fields },
        activate: true,
        settings,
      })
    );
    const t = await inStore(s.id, () => shippingCarrierService.testConnection(s.id, carrier));
    expect(t.test.ok, JSON.stringify(t.test)).toBe(true);
    await inStore(s.id, () =>
      shippingCarrierService.upsertCarrierConfig(s.id, carrier, { enabled: true })
    );
  };
  const pickupSettings = {
    pickupName: 'Dahab Store',
    pickupPhone: '+201000000001',
    pickupCity: 'Cairo',
    pickupLine1: '12 Tahrir St',
  };

  /** A store with a booked Bosta (or Aramex) shipment. */
  async function booked(tag: string, carrier: 'bosta' | 'aramex' = 'bosta') {
    const s = await mkStore(tag);
    if (carrier === 'bosta') {
      await connect(
        s,
        'bosta',
        { apiKey: BOSTA_STUB.apiKey, businessLocationId: 'LOC1' },
        pickupSettings
      );
    } else {
      await connect(
        s,
        'aramex',
        { ...ARAMEX_STUB.credentials },
        { ...pickupSettings, productType: 'CDS' }
      );
    }
    const o = await mkOrder(s);
    const sh = await inStore(s.id, () =>
      shippingCarrierService.createShipmentForOrder(s.id, o.id, carrier)
    );
    expect(sh.status).toBe('created');
    return { s, shipment: sh };
  }

  const http = () => request(app);
  const auth = (j: string) => ({ Authorization: `Bearer ${j}` });
  const post = (s: { id: string; jwt: string }, path: string, body: unknown) =>
    asApp(async () => http().post(`/api/v1/stores/${s.id}${path}`).set(auth(s.jwt)).send(body));
  const get = (s: { id: string; jwt: string }, path: string) =>
    asApp(async () => http().get(`/api/v1/stores/${s.id}${path}`).set(auth(s.jwt)));
  const bostaPickupCalls = () =>
    bosta.requests.filter(r => r.method === 'POST' && r.path === '/pickups').length;

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 4, role: 'owner' });
    await redis.connect().catch(() => undefined);
    bostaServer = await serveStub(bosta.fetch);
    aramexServer = await serveStub(aramex.fetch);
    process.env.BOSTA_BASE_URL = `${bostaServer.url}/api/v2`;
    process.env.ARAMEX_BASE_URL = `${aramexServer.url}/ShippingAPI.V2`;
    process.env.CARRIER_CALL_TIMEOUT_MS = '1500';
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api/v1/stores', shippingCarrierRoutes);
    app.use(errorHandler);
  });

  beforeEach(() => {
    bosta.faults.down = null;
    aramex.faults.down = null;
  });

  afterAll(async () => {
    const ids = stores.map(s => s.id);
    await owner.shipmentPickup
      .deleteMany({ where: { storeId: { in: ids } } })
      .catch(() => undefined);
    await owner.auditLog.deleteMany({ where: { storeId: { in: ids } } }).catch(() => undefined);
    await owner.shipment.deleteMany({ where: { storeId: { in: ids } } }).catch(() => undefined);
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

  it('Bosta: the admin route requests the pickup; the panel shows it with the slot Bosta assigned', async () => {
    const { s, shipment } = await booked('bosta-ok');
    const before = await get(s, `/shipments/${shipment.id}/pickup`);
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({
      mode: 'request',
      window: 'none',
      canRequest: true,
      active: null,
    });

    const res = await post(s, `/shipments/${shipment.id}/pickup`, {
      date: tomorrow(),
      idempotencyKey: key(),
    });
    expect(res.status).toBe(201);
    expect(res.body.data.pickup).toMatchObject({
      status: 'requested',
      pickupDate: tomorrow(),
      carrierTimeSlot: '10:00 to 13:00',
      address: expect.objectContaining({ line1: '12 Tahrir St', city: 'Cairo' }),
    });
    const sent = bosta.pickups.at(-1)!;
    expect(sent).toMatchObject({
      businessLocationId: 'LOC1',
      scheduledDate: tomorrow(),
      trackingNumbers: [shipment.trackingNumber],
    });
    expect(res.body.data.pickup.carrierPickupId).toBe(sent._id);

    const after = await get(s, `/shipments/${shipment.id}/pickup`);
    expect(after.body.data.canRequest).toBe(false);
    expect(after.body.data.active.id).toBe(res.body.data.pickup.id);
    expect(
      await owner.auditLog.count({ where: { storeId: s.id, action: 'SHIPMENT_PICKUP_REQUESTED' } })
    ).toBe(1);
  });

  it('idempotent: a replayed key, a second request while one is live, and two concurrent requests are ONE carrier pickup', async () => {
    const { s, shipment } = await booked('bosta-idem');
    const k = key();
    const calls0 = bostaPickupCalls();
    const first = await post(s, `/shipments/${shipment.id}/pickup`, {
      date: tomorrow(),
      idempotencyKey: k,
    });
    expect(first.status).toBe(201);
    // the same submit again (double click / network retry)
    const replay = await post(s, `/shipments/${shipment.id}/pickup`, {
      date: tomorrow(),
      idempotencyKey: k,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({
      created: false,
      pickup: { id: first.body.data.pickup.id },
    });
    // a NEW key while the first pickup is live returns the live one
    const second = await post(s, `/shipments/${shipment.id}/pickup`, {
      date: addDays(tomorrow(), 1),
      idempotencyKey: key(),
    });
    expect(second.status).toBe(200);
    expect(second.body.data.pickup.id).toBe(first.body.data.pickup.id);
    expect(bostaPickupCalls()).toBe(calls0 + 1);
    expect(await owner.shipmentPickup.count({ where: { shipmentId: shipment.id } })).toBe(1);

    // two concurrent requests for another shipment: one row, one carrier call
    const other = await booked('bosta-race');
    const calls1 = bostaPickupCalls();
    const [a, b] = await Promise.all([
      inStore(other.s.id, () =>
        requestPickup(other.s.id, other.shipment.id, { date: tomorrow(), idempotencyKey: key() })
      ),
      inStore(other.s.id, () =>
        requestPickup(other.s.id, other.shipment.id, { date: tomorrow(), idempotencyKey: key() })
      ),
    ]);
    expect(a.pickup.id).toBe(b.pickup.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(bostaPickupCalls()).toBe(calls1 + 1);
    expect(await owner.shipmentPickup.count({ where: { shipmentId: other.shipment.id } })).toBe(1);
  });

  it('Bosta: cancel deletes it at Bosta, is audit-logged, and a new pickup can be requested', async () => {
    const { s, shipment } = await booked('bosta-cancel');
    const r = await post(s, `/shipments/${shipment.id}/pickup`, {
      date: tomorrow(),
      idempotencyKey: key(),
    });
    const id = r.body.data.pickup.id;
    const c = await post(s, `/shipments/${shipment.id}/pickup/${id}/cancel`, {});
    expect(c.status).toBe(200);
    expect(c.body.data.pickup.status).toBe('cancelled');
    expect(bosta.pickups.find(p => p._id === r.body.data.pickup.carrierPickupId)?.state).toBe(
      'Canceled'
    );
    expect(
      await owner.auditLog.count({ where: { storeId: s.id, action: 'SHIPMENT_PICKUP_CANCELLED' } })
    ).toBe(1);
    // cancelling again is a no-op, not a second carrier call
    const deletes = bosta.requests.filter(x => x.method === 'DELETE').length;
    expect((await post(s, `/shipments/${shipment.id}/pickup/${id}/cancel`, {})).status).toBe(200);
    expect(bosta.requests.filter(x => x.method === 'DELETE').length).toBe(deletes);
    const again = await post(s, `/shipments/${shipment.id}/pickup`, {
      date: tomorrow(),
      idempotencyKey: key(),
    });
    expect(again.status).toBe(201);
  });

  it('a carrier outage leaves a failed row that says the pickup may exist; a new request works', async () => {
    const { s, shipment } = await booked('bosta-down');
    bosta.faults.down = 'unavailable';
    const res = await post(s, `/shipments/${shipment.id}/pickup`, {
      date: tomorrow(),
      idempotencyKey: key(),
    });
    bosta.faults.down = null;
    expect(res.status).toBe(502);
    const row = await owner.shipmentPickup.findFirstOrThrow({ where: { shipmentId: shipment.id } });
    expect(row.status).toBe('failed');
    expect(row.error).toContain('may have been booked');
    const ok = await post(s, `/shipments/${shipment.id}/pickup`, {
      date: tomorrow(),
      idempotencyKey: key(),
    });
    expect(ok.status).toBe(201);
  });

  it('Aramex: a window is required; the request books it and cancel uses the GUID', async () => {
    const { s, shipment } = await booked('aramex', 'aramex');
    const state = await get(s, `/shipments/${shipment.id}/pickup`);
    expect(state.body.data).toMatchObject({ mode: 'request', window: 'times', cancellable: true });
    const noWindow = await post(s, `/shipments/${shipment.id}/pickup`, {
      date: tomorrow(),
      idempotencyKey: key(),
    });
    expect(noWindow.status).toBe(400);
    expect(noWindow.body.error.code).toBe('PICKUP_WINDOW_REQUIRED');
    const bad = await post(s, `/shipments/${shipment.id}/pickup`, {
      date: tomorrow(),
      window: { from: '16:00', to: '10:00' },
      idempotencyKey: key(),
    });
    expect(bad.status).toBe(400);
    const res = await post(s, `/shipments/${shipment.id}/pickup`, {
      date: tomorrow(),
      window: { from: '10:00', to: '16:00' },
      idempotencyKey: key(),
    });
    expect(res.status).toBe(201);
    expect(res.body.data.pickup).toMatchObject({
      status: 'requested',
      windowFrom: '10:00',
      windowTo: '16:00',
    });
    expect(res.body.data.pickup.carrierPickupId).toMatch(/^[0-9a-f-]{36}$/);
    const c = await post(
      s,
      `/shipments/${shipment.id}/pickup/${res.body.data.pickup.id}/cancel`,
      {}
    );
    expect(c.status).toBe(200);
    expect(aramex.cancelledPickups.has(res.body.data.pickup.carrierPickupId)).toBe(true);
  });

  it('refused before any carrier call: ShipBlu (automatic), a delivered shipment, a date out of range; another store sees nothing', async () => {
    const { s, shipment } = await booked('refusals');
    const calls = bostaPickupCalls();
    const far = await post(s, `/shipments/${shipment.id}/pickup`, {
      date: addDays(cairoToday(), 60),
      idempotencyKey: key(),
    });
    expect(far.status).toBe(400);
    expect(far.body.error.code).toBe('PICKUP_DATE_OUT_OF_RANGE');
    const past = await post(s, `/shipments/${shipment.id}/pickup`, {
      date: addDays(cairoToday(), -1),
      idempotencyKey: key(),
    });
    expect(past.status).toBe(400);

    await owner.shipment.update({ where: { id: shipment.id }, data: { status: 'delivered' } });
    const delivered = await post(s, `/shipments/${shipment.id}/pickup`, {
      date: tomorrow(),
      idempotencyKey: key(),
    });
    expect(delivered.status).toBe(409);
    expect(delivered.body.error.code).toBe('PICKUP_NOT_ALLOWED');

    const o = await mkOrder(s);
    const shipblu = await owner.shipment.create({
      data: {
        storeId: s.id,
        orderId: o.id,
        carrier: 'shipblu',
        status: 'created',
        trackingNumber: 'SB1',
        pickupAddress: {},
        deliveryAddress: {},
      },
    });
    const sb = await post(s, `/shipments/${shipblu.id}/pickup`, {
      date: tomorrow(),
      idempotencyKey: key(),
    });
    expect(sb.status).toBe(409);
    expect(sb.body.error.code).toBe('PICKUP_AUTOMATIC');
    expect((await get(s, `/shipments/${shipblu.id}/pickup`)).body.data.mode).toBe('automatic');
    expect(bostaPickupCalls()).toBe(calls);

    const stranger = await mkStore('stranger');
    // the stranger's own store scope: under RLS the shipment does not exist for them
    expect((await get(stranger, `/shipments/${shipment.id}/pickup`)).status).toBe(404);
    expect(
      (
        await post(stranger, `/shipments/${shipment.id}/pickup`, {
          date: tomorrow(),
          idempotencyKey: key(),
        })
      ).status
    ).toBe(404);
  });
});
