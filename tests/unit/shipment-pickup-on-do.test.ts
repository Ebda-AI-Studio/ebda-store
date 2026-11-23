/**
 * PROVIDERS-18 courier pickups on the Durable Object + platform D1 (ported from tests/integration/shipment-pickup.test.ts, which ran
 * against a live relational database with an `ebda_app` login under strict RLS): the real Bosta and Aramex adapters talking to
 * loopback stubs, the real shipping router and pickup service, on one StoreDO schema PER STORE (real money ops for the orders), the
 * directory and access gate on the platform D1. No real carrier is called; no real pickup is booked.
 *
 *   - request over the admin route: the row, the carrier call, the panel state
 *   - IDEMPOTENT: a replayed key, a second request while one is live and two concurrent requests are each ONE carrier pickup
 *     (the DO's own `shipment_pickups_store_id_idempotency_key_key` / `shipment_pickups_one_active` unique indexes are the guard)
 *   - cancel where the carrier allows it (Bosta DELETE, Aramex CancelPickup), audit-logged
 *   - a carrier outage leaves a `failed` row that says the pickup MAY exist; a new request works
 *   - refusals before any call: ShipBlu (automatic), a delivered shipment, a date out of range, an Aramex request without a window;
 *     another store sees nothing (a second DO: one database per store replaces row-level security)
 *
 * Mutation proofs (each turns the named tests red): drop the claim's race recovery (`if (winner) return ...`) in
 * shipment-pickup.service.ts -> "idempotent"; drop the partial index `shipment_pickups_one_active` -> "idempotent".
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
import { errorHandler } from '@api/middleware/error-handler';
import { shippingCarrierService } from '@api/services/shipping-carrier.service';
import { requestPickup } from '@api/services/shipment-pickup.service';
import { cairoToday } from '@api/services/carriers/pickup-time';
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

type Actor = { id: string; userId: string; email: string; jwt: string };
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const tomorrow = () => addDays(cairoToday(), 1);
const key = () => crypto.randomUUID();

function account(role: string, tag: string): { userId: string; email: string } {
  const userId = crypto.randomUUID();
  const email = `${tag}-${userId.slice(0, 6)}@test.local`;
  h.accounts.set(userId, { role, email });
  return { userId, email };
}
async function mkStore(tag: string): Promise<Actor> {
  const u = account('store_admin', `owner-${tag}`);
  const id = crypto.randomUUID();
  const slug = `pu-${tag}-${id.slice(0, 6)}`;
  d1.prepare(
    `INSERT INTO stores (id, name, slug, owner_id, status) VALUES (?, ?, ?, ?, 'active')`
  ).run(id, `pu-${tag}`, slug, u.userId);
  const w = worlds.add(id, { money: true });
  w.seedProfile({ name: `pu-${tag}`, slug, ownerId: u.userId });
  w.sqlite.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status, cost_price) VALUES ('p1', '${id}', 'Widget', 'widget', 1000, 100000, 'active', 400)`
  );
  return { id, ...u, jwt: u.userId };
}

/** A confirmed COD order (20,000 piastres, no payment row), the way the money op creates it. */
async function mkOrder(s: { id: string }) {
  seq += 1;
  const w = worlds.get(s.id);
  const created = await w.money!.createOrder({
    lines: [{ productId: 'p1', quantity: 1 }],
    shippingAddress: {
      firstName: 'Mona',
      lastName: 'Adel',
      phone: `+2010123${String(seq).padStart(5, '0')}`,
      // Aramex requires a customer email at booking (#194, manual REQ24)
      email: 'mona@example.com',
      address1: '5 Nile Corniche',
      city: 'Giza',
      state: 'Giza',
      area: 'Dokki',
      country: 'EG',
    },
    paymentMethod: 'cod',
  } as never);
  await w.money!.orderStatus({ orderId: created.orderId, status: 'confirmed' });
  w.sqlite
    .prepare('UPDATE orders SET subtotal = 20000, total = 20000 WHERE id = ?')
    .run(created.orderId);
  w.sqlite.prepare('DELETE FROM payments WHERE order_id = ?').run(created.orderId);
  return { id: created.orderId };
}

const connect = async (
  s: { id: string },
  carrier: 'bosta' | 'aramex',
  fields: Record<string, string>,
  settings: Record<string, unknown>
) => {
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
  await worlds.withStoreRepo(s.id, () =>
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
  const sh = await worlds.withStoreRepo(s.id, () =>
    shippingCarrierService.createShipmentForOrder(s.id, o.id, carrier)
  );
  expect(sh.status).toBe('created');
  return { s, shipment: sh };
}

const auth = (j: string) => ({ 'x-test-user': j });
const post = (s: { id: string; jwt: string }, path: string, body: unknown) =>
  request(app).post(`/api/v1/stores/${s.id}${path}`).set(auth(s.jwt)).send(body);
const get = (s: { id: string; jwt: string }, path: string) =>
  request(app).get(`/api/v1/stores/${s.id}${path}`).set(auth(s.jwt));
const bostaPickupCalls = () =>
  bosta.requests.filter(r => r.method === 'POST' && r.path === '/pickups').length;
const pickupRows = (s: { id: string }, shipmentId: string) =>
  worlds.get(s.id).rows('SELECT * FROM shipment_pickups WHERE shipment_id = ?', shipmentId);
const auditCount = (storeId: string, action: string) =>
  h.audit.filter(e => e.storeId === storeId && e.action === action).length;

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
  app.use(express.json());
  app.use('/api/v1/stores', shippingCarrierRoutes);
  app.use(errorHandler);
});
beforeEach(() => {
  bosta.faults.down = null;
  aramex.faults.down = null;
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

describe('PROVIDERS-18 shipment pickups on the DO (one StoreDO per store)', () => {
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
    expect(auditCount(s.id, 'SHIPMENT_PICKUP_REQUESTED')).toBe(1);
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
    expect(pickupRows(s, shipment.id)).toHaveLength(1);

    // two concurrent requests for another shipment: one row, one carrier call
    const other = await booked('bosta-race');
    const calls1 = bostaPickupCalls();
    const [a, b] = await Promise.all([
      worlds.withStoreRepo(other.s.id, () =>
        requestPickup(other.s.id, other.shipment.id, { date: tomorrow(), idempotencyKey: key() })
      ),
      worlds.withStoreRepo(other.s.id, () =>
        requestPickup(other.s.id, other.shipment.id, { date: tomorrow(), idempotencyKey: key() })
      ),
    ]);
    expect(a.pickup.id).toBe(b.pickup.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(bostaPickupCalls()).toBe(calls1 + 1);
    expect(pickupRows(other.s, other.shipment.id)).toHaveLength(1);
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
    expect(auditCount(s.id, 'SHIPMENT_PICKUP_CANCELLED')).toBe(1);
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
    const rows = pickupRows(s, shipment.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(String(rows[0].error)).toContain('may have been booked');
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

    const w = worlds.get(s.id);
    w.sqlite.prepare(`UPDATE shipments SET status = 'delivered' WHERE id = ?`).run(shipment.id);
    const delivered = await post(s, `/shipments/${shipment.id}/pickup`, {
      date: tomorrow(),
      idempotencyKey: key(),
    });
    expect(delivered.status).toBe(409);
    expect(delivered.body.error.code).toBe('PICKUP_NOT_ALLOWED');

    const o = await mkOrder(s);
    const shipbluId = crypto.randomUUID();
    insertSqlite(w.sqlite, 'Shipment', [
      {
        id: shipbluId,
        storeId: s.id,
        orderId: o.id,
        carrier: 'shipblu',
        status: 'created',
        trackingNumber: 'SB1',
        pickupAddress: {},
        deliveryAddress: {},
      },
    ]);
    const sb = await post(s, `/shipments/${shipbluId}/pickup`, {
      date: tomorrow(),
      idempotencyKey: key(),
    });
    expect(sb.status).toBe(409);
    expect(sb.body.error.code).toBe('PICKUP_AUTOMATIC');
    expect((await get(s, `/shipments/${shipbluId}/pickup`)).body.data.mode).toBe('automatic');
    expect(bostaPickupCalls()).toBe(calls);

    const stranger = await mkStore('stranger');
    // the stranger's own DO has no such shipment (one database per store)
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
