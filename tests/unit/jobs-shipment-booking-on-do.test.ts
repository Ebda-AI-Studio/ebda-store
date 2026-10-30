/**
 * Ruling CF-JOBS-4: the whole shipment-create booking on a store served by its Durable Object, in process (the real DO schema
 * on SQLite, the real prisma-lite read/write client, the real money ops): claim -> carrier -> record the result -> the order
 * moves to shipped. `@ebda/database`'s `prisma` THROWS on any use, so a write that slipped to Postgres (the split-backend
 * defect: the carrier booked, the DO never learnt the tracking number) fails the test.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  send: vi.fn(async () => undefined),
  sendAfter: vi.fn(async () => undefined),
}));

vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  const boom = (what: string) => () => {
    throw new Error(`Postgres touched: ${what}`);
  };
  return {
    ...real,
    prisma: new Proxy({}, { get: (_t, p) => boom(`prisma.${String(p)}`)() }),
    runInTenantContext: boom('runInTenantContext'),
    withStore: boom('withStore'),
    runInStoreScope: async (_s: string, fn: () => Promise<unknown>) => fn(),
    currentStoreId: () => STORE,
  };
});
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    send: h.send,
    createFunction: (o: unknown, f: unknown) => ({ options: o, handler: f }),
  },
}));
vi.mock('@api/lib/event-after-commit', () => ({ sendEventAfterCommit: h.sendAfter }));
vi.mock('@api/services/redis.service', () => ({
  redis: { get: async () => null, set: async () => undefined, del: async () => undefined },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  answerMoneyOp,
  createDoClient,
  createPrismaLite,
  decodeRpc,
  encodeRpc,
  ensureIdempotencySchema,
  ensureMoneyOpsSchema,
  ensurePaymentSchema,
  runReads,
  runWrites,
} from '@ebda-src/repo';
import { makeMoneyClient, withRepo } from '@api/lib/repo-factory';
import { AppError } from '@api/middleware/error-handler';
import { shippingCarrierService } from '@api/services/shipping-carrier.service';
import { CARRIER_REGISTRY } from '@api/services/carriers/registry';
import { META, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';

const STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const sqlite = openSqlite();
let money: ReturnType<typeof makeMoneyClient>;
let repo: { storeId: string; backend: 'do'; db: never; writer: never; money: never };

beforeAll(() => {
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const sync = nodeSyncSql(sqlite);
  ensureMoneyOpsSchema(sync);
  ensurePaymentSchema(sync);
  sqlite.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status, cost_price) VALUES ('p1', '${STORE}', 'Widget', 'widget', 1000, 50, 'active', 400)`
  );
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId: STORE }) as never;
  const c = createDoClient(
    q => runReads(lite, q),
    m => runWrites(lite, sql, m)
  ) as never;
  money = makeMoneyClient(async (op, args, key) => {
    const r = answerMoneyOp(sync, STORE, op, encodeRpc(args), key);
    if (!r.ok) throw new AppError(r.status, r.code, r.message);
    return decodeRpc(r.json);
  });
  repo = { storeId: STORE, backend: 'do', db: c, writer: c, money: money as never };
});
beforeEach(() => {
  h.send.mockClear();
  h.sendAfter.mockClear();
});

/** A confirmed COD order, ready to ship. */
async function readyOrder(n: number): Promise<string> {
  const o = await money.createOrder({
    lines: [{ productId: 'p1', quantity: 1 }],
    shippingAddress: { firstName: 'A', lastName: 'B', phone: `0100000000${n}`, city: 'Cairo' },
    paymentMethod: 'cod',
  } as never);
  await money.orderStatus({ orderId: o.orderId, status: 'confirmed' });
  await money.orderStatus({ orderId: o.orderId, status: 'processing' });
  return o.orderId;
}
const row = (sql: string, ...p: unknown[]) =>
  sqlite.prepare(sql).get(...(p as never[])) as Record<string, any> | undefined;

describe('shipment booking on a DO store', () => {
  it('claim -> carrier -> record -> order shipped: every write lands in the DO', async () => {
    const orderId = await readyOrder(1);
    const s = await withRepo(repo as never, () =>
      shippingCarrierService.createShipmentForOrder(STORE, orderId, 'manual', {
        manual: { carrierName: 'Courier', trackingNumber: 'TRK-1' },
      })
    );
    expect(s.status).toBe('created');
    expect(s.trackingNumber).toBe('TRK-1');
    const db = row(
      'SELECT status, tracking_number, carrier, create_attempts FROM shipments WHERE order_id = ?',
      orderId
    );
    expect(db).toMatchObject({
      status: 'created',
      tracking_number: 'TRK-1',
      carrier: 'manual',
      create_attempts: 1,
    });
    expect(row('SELECT status FROM orders WHERE id = ?', orderId)?.status).toBe('shipped');
  });

  it('a second booking of the same order returns the first and books nothing more', async () => {
    const orderId = await readyOrder(2);
    const run = () =>
      withRepo(repo as never, () =>
        shippingCarrierService.createShipmentForOrder(STORE, orderId, 'manual', {
          manual: { carrierName: 'Courier', trackingNumber: 'TRK-2' },
        })
      );
    const a = await run();
    const b = await run();
    expect(b.id).toBe(a.id);
    expect(row('SELECT count(*) n FROM shipments WHERE order_id = ?', orderId)?.n).toBe(1);
  });

  it('a carrier failure is recorded ON the DO row (creation_failed + the reason), the order is untouched, and a retry re-claims it', async () => {
    const orderId = await readyOrder(3);
    const original = CARRIER_REGISTRY.manual.createShipment;
    CARRIER_REGISTRY.manual.createShipment = async () => {
      throw new Error('carrier is down');
    };
    try {
      await expect(
        withRepo(repo as never, () =>
          shippingCarrierService.createShipmentForOrder(STORE, orderId, 'manual', {
            manual: { carrierName: 'Courier', trackingNumber: 'TRK-3' },
          })
        )
      ).rejects.toThrow('carrier is down');
    } finally {
      CARRIER_REGISTRY.manual.createShipment = original;
    }
    expect(row('SELECT status, error FROM shipments WHERE order_id = ?', orderId)).toMatchObject({
      status: 'creation_failed',
      error: 'carrier is down',
    });
    expect(row('SELECT status FROM orders WHERE id = ?', orderId)?.status).toBe('processing');
    const retry = await withRepo(repo as never, () =>
      shippingCarrierService.createShipmentForOrder(STORE, orderId, 'manual', {
        manual: { carrierName: 'Courier', trackingNumber: 'TRK-3' },
      })
    );
    expect(retry.status).toBe('created');
    expect(
      row('SELECT create_attempts a, tracking_number t FROM shipments WHERE order_id = ?', orderId)
    ).toEqual({
      a: 2,
      t: 'TRK-3',
    });
  });

  it('tracking and cancel write the DO row too (applyTrackingEntries, cancelShipment)', async () => {
    const orderId = await readyOrder(4);
    const s = await withRepo(repo as never, () =>
      shippingCarrierService.createShipmentForOrder(STORE, orderId, 'manual', {
        manual: { carrierName: 'Courier', trackingNumber: 'TRK-4' },
      })
    );
    await withRepo(repo as never, () =>
      shippingCarrierService.applyTrackingEntries(
        s.id,
        [{ status: 'in_transit', timestamp: new Date(), description: 'out' }],
        'merchant_manual'
      )
    );
    expect(row('SELECT status FROM shipments WHERE id = ?', s.id)?.status).toBe('in_transit');
    await withRepo(repo as never, () =>
      shippingCarrierService.cancelShipment(s.id, { force: true })
    );
    expect(row('SELECT status FROM shipments WHERE id = ?', s.id)?.status).toBe('cancelled');
    expect(row('SELECT status FROM orders WHERE id = ?', orderId)?.status).toBe('processing');
  });
});
