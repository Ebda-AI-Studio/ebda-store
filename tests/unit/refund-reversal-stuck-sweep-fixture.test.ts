/**
 * Refund-reversal stuck sweep, proven on a stuck-order fixture (register row "Refund-reversal stuck sweep": the sweep logs nothing on an
 * empty run, so a live run of this job is invisible; this pins what it does when an order IS stuck).
 * The real `handleRefundReversalStuckSweep` runs with the alarm event of a Durable Object store, reading the StoreDO schema
 * (node:sqlite through prisma-lite, the wiring of product-3d-models-do.test.ts). Fixture orders:
 *   stuck      reversal requested 30 min ago, never claimed        -> re-sent (restoreInventory true, notify false)
 *   fresh      requested 2 min ago (inside the 10 min window)       -> left alone
 *   ancient    requested 2 days ago (older than the 12 h floor)     -> left alone (the back-catalogue is never re-fired)
 *   reversed   requested 30 min ago, refund_reversed_at set         -> left alone (the reversals ran)
 *   legacy     no request stamp, cancelled 30 min ago               -> re-sent through the original status predicate
 *   other store's stuck order                                       -> never read on this store's alarm
 * A reversal stuck for more than 3 windows (30 min) pages a P1 naming only those orders.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqlite, META } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { createPrismaLite } from '../../packages/repo/src/prisma-lite/client';

const STORE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({ send: vi.fn(), alert: vi.fn() }));

const raw = openSqlite();
const lite = createPrismaLite(META, nodeSqlRunner(raw), 'store-do', { unscoped: true }) as any;

vi.mock('../../apps/api/src/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<object>()),
  storeRepo: async () => ({ backend: 'do', db: lite, writer: lite }),
}));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { createFunction: (_c: unknown, fn: unknown) => fn, send: h.send },
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: h.alert }));

import { handleRefundReversalStuckSweep } from '../../apps/api/src/lib/inngest/functions/refund-reversal-stuck-sweep';

const step = { run: async <T>(_id: string, fn: () => Promise<T>) => fn() };
const MIN = 60_000;
let seq = 0;
function order(
  store: string,
  o: {
    status?: string;
    requestedMinAgo?: number | null;
    reversed?: boolean;
    updatedMinAgo?: number;
  }
) {
  const id = `ord-${++seq}`;
  const now = Date.now();
  raw
    .prepare(
      `INSERT INTO orders (id, store_id, order_number, status, subtotal, total, currency, shipping_address, billing_address, refund_reversal_requested_at, refund_reversed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1000, 1000, 'EGP', '{}', '{}', ?, ?, ?, ?)`
    )
    .run(
      id,
      store,
      `ORD-${seq}`,
      o.status ?? 'cancelled',
      o.requestedMinAgo == null ? null : now - o.requestedMinAgo * MIN,
      o.reversed ? now : null,
      now - 3 * 24 * 60 * MIN,
      now - (o.updatedMinAgo ?? o.requestedMinAgo ?? 0) * MIN
    );
  return id;
}

beforeEach(() => {
  raw.exec('DELETE FROM orders');
  h.send.mockReset();
  h.send.mockResolvedValue(undefined);
  h.alert.mockReset();
  h.alert.mockResolvedValue('sent');
});

describe('refund-reversal stuck sweep on a stuck-order fixture', () => {
  it('re-sends order/refunded for the stuck and the legacy cancelled order only, with notify off and stock restore on', async () => {
    const stuck = order(STORE, { requestedMinAgo: 30 });
    order(STORE, { requestedMinAgo: 2 }); // fresh
    order(STORE, { requestedMinAgo: 2 * 24 * 60 }); // ancient: past the recency floor
    order(STORE, { requestedMinAgo: 30, reversed: true }); // the fanout ran
    const legacy = order(STORE, { requestedMinAgo: null, status: 'cancelled', updatedMinAgo: 40 });
    order(OTHER, { requestedMinAgo: 30 }); // another store: not this alarm's
    const out = await handleRefundReversalStuckSweep(step, {
      data: { alarm: true, storeId: STORE },
    });
    const sent = h.send.mock.calls.map(c => c[0]);
    expect(sent.map(e => e.data.orderId).sort()).toEqual([legacy, stuck].sort());
    for (const e of sent) {
      expect(e).toMatchObject({
        name: 'order/refunded',
        data: { storeId: STORE, currency: 'EGP', restoreInventory: true, notify: false },
      });
    }
    expect(out).toMatchObject({ swept: 2, resent: 2 });
  });

  it('pages a P1 only for reversals stuck longer than three windows, naming those orders', async () => {
    const old = order(STORE, { requestedMinAgo: 45 });
    order(STORE, { requestedMinAgo: 15 }); // stuck but not yet very stale
    const out = await handleRefundReversalStuckSweep(step, {
      data: { alarm: true, storeId: STORE },
    });
    expect(out).toMatchObject({ swept: 2, resent: 2, alerted: 1 });
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.alert.mock.calls[0]![0]).toMatchObject({
      level: 'p1',
      source: 'order.refund.reversal.stuck',
      context: { ids: [old] },
    });
  });

  it('an empty store does nothing: no send, no alert', async () => {
    const out = await handleRefundReversalStuckSweep(step, {
      data: { alarm: true, storeId: STORE },
    });
    expect(out).toEqual({ swept: 0, resent: 0, alerted: 0 });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
  });

  it('a failed re-send for one order does not stop the others and is not counted as resent', async () => {
    const a = order(STORE, { requestedMinAgo: 30 });
    const b = order(STORE, { requestedMinAgo: 31 });
    h.send.mockImplementationOnce(async () => {
      throw new Error('inngest down');
    });
    const out = await handleRefundReversalStuckSweep(step, {
      data: { alarm: true, storeId: STORE },
    });
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ swept: 2, resent: 1 });
    expect([a, b]).toHaveLength(2);
  });
});
