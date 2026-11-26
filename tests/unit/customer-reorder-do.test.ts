/**
 * Ported from tests/integration/customer-reorder.test.ts (Postgres, strict `ebda_app` role). The real CustomerReorderService runs on the StoreDO
 * schema (node:sqlite through prisma-lite, the wiring of product-3d-models-do.test.ts), one database PER STORE as in production, so "scoped to the
 * store" is the per-store DO boundary plus the service's own storeId filter. Proves the id list is per customer: distinct products from the last
 * three PAID or DELIVERED orders, newest first, at most 12, still on sale; negative controls: another customer's orders, another store's orders,
 * cancelled and unpaid orders, archived and deleted products, a fourth-oldest order. The HTTP half (private/no-store, 401, 403, token bound to one
 * store) is apps/api/workers-test/customer-reorder.test.ts on the built Worker.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { openSqlite, META } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { createPrismaLite } from '../../packages/repo/src/prisma-lite/client';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const dbs = { [A]: openSqlite(), [B]: openSqlite() } as Record<
  string,
  ReturnType<typeof openSqlite>
>;
const lites = Object.fromEntries(
  Object.entries(dbs).map(([k, d]) => [
    k,
    createPrismaLite(META, nodeSqlRunner(d), 'store-do', { unscoped: true }) as any,
  ])
) as Record<string, any>;

vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeDb: async (id: string) => lites[id],
  storeWriter: async (id: string) => lites[id],
  storeRepo: async () => ({ backend: 'do' }),
}));

import { CustomerReorderService } from '../../apps/api/src/services/customer-reorder.service';

const customerId = 'cust-1';
const otherCustomerId = 'cust-2';
const newCustomerId = 'cust-3';
const p: Record<string, string> = {};
let seq = 0;

function mkProduct(
  store: string,
  key: string,
  extra: { status?: string; deletedAt?: number } = {}
) {
  p[key] = `prod-${key}`;
  dbs[store]!.prepare(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status, deleted_at) VALUES (?, ?, ?, ?, 5000, 10, ?, ?)`
  ).run(
    p[key],
    store,
    `Reorder ${key}`,
    `ro-${key}`,
    extra.status ?? 'active',
    extra.deletedAt ?? null
  );
}
function mkOrder(o: {
  sid: string;
  cid: string;
  keys: string[];
  daysAgo: number;
  status?: string;
  paymentStatus?: string;
}) {
  const id = `order-${++seq}`;
  const at = Date.now() - o.daysAgo * 86_400_000;
  const d = dbs[o.sid]!;
  d.prepare(
    `INSERT INTO orders (id, store_id, customer_id, order_number, status, payment_status, subtotal, total, shipping_address, billing_address, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 5000, 5000, '{}', '{}', ?, ?)`
  ).run(id, o.sid, o.cid, `RO-${seq}`, o.status ?? 'confirmed', o.paymentStatus ?? 'paid', at, at);
  for (const k of o.keys)
    d.prepare(
      `INSERT INTO order_items (id, order_id, product_id, product_name, quantity, price, total) VALUES (?, ?, ?, ?, 1, 5000, 5000)`
    ).run(`${id}-${k}`, id, p[k], `Reorder ${k}`);
}

beforeAll(() => {
  for (const k of 'abcdefghijklmn'.split('')) mkProduct(A, k);
  mkProduct(A, 'archived', { status: 'archived' });
  mkProduct(A, 'deleted', { deletedAt: Date.now() });
  for (const k of ['cancelled-only', 'unpaid-only', 'old']) mkProduct(A, k);
  mkProduct(B, 'foreign');
  // the customer's qualifying orders: newest first -> order3, order2, order1
  mkOrder({ sid: A, cid: customerId, keys: ['a', 'b'], daysAgo: 9 }); // order1
  mkOrder({ sid: A, cid: customerId, keys: ['c', 'a', 'archived', 'deleted'], daysAgo: 5 }); // order2
  mkOrder({
    sid: A,
    cid: customerId,
    keys: ['d', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n'],
    daysAgo: 1,
    status: 'delivered',
    paymentStatus: 'unpaid', // cash on delivery, delivered
  }); // order3
  // do NOT count
  mkOrder({ sid: A, cid: customerId, keys: ['cancelled-only'], daysAgo: 0.5, status: 'cancelled' });
  mkOrder({
    sid: A,
    cid: customerId,
    keys: ['unpaid-only'],
    daysAgo: 0.4,
    status: 'pending',
    paymentStatus: 'unpaid',
  });
  mkOrder({ sid: A, cid: customerId, keys: ['old'], daysAgo: 30 }); // the fourth qualifying order
  mkOrder({ sid: A, cid: otherCustomerId, keys: ['b'], daysAgo: 2 });
  // another store's order for the same customer id: never read from store A (and store B's own product is not A's)
  mkOrder({ sid: B, cid: customerId, keys: ['foreign'], daysAgo: 1 });
});

describe('customer reorder source on the StoreDO schema (Ruling B4-8)', () => {
  it('is the distinct products of the last three paid or delivered orders, newest order first, at most 12, on sale only', async () => {
    const ids = await CustomerReorderService.productIds(A, customerId);
    // order3 has 11 products (d..n); order2 adds a, archived, c, deleted (the archived and deleted ones are not on sale); order1 adds b:
    // the first 12 on sale are d..n and a
    expect(ids).toEqual([...'defghijklmn', 'a'].map(k => p[k]));
    expect(ids).toHaveLength(12);
    const all = await CustomerReorderService.productIds(A, customerId, 12);
    expect(all.every(id => id !== p.archived && id !== p.deleted)).toBe(true);
  });

  it('negative controls: cancelled, unpaid, the fourth-oldest order, archived and deleted never appear', async () => {
    const ids = new Set(await CustomerReorderService.productIds(A, customerId));
    for (const k of ['cancelled-only', 'unpaid-only', 'old', 'archived', 'deleted', 'foreign'])
      expect(ids.has(p[k]!), k).toBe(false);
  });

  it('is scoped to the customer and the store', async () => {
    expect(await CustomerReorderService.productIds(A, otherCustomerId)).toEqual([p.b]);
    expect(await CustomerReorderService.productIds(A, newCustomerId)).toEqual([]);
    // the same customer id on store B reads store B's own database: its one order holds a product that is on sale there
    expect(await CustomerReorderService.productIds(B, customerId)).toEqual([p.foreign]);
    expect(await CustomerReorderService.productIds(B, otherCustomerId)).toEqual([]);
  });

  it('a smaller limit keeps the newest', async () => {
    expect(await CustomerReorderService.productIds(A, customerId, 3)).toEqual(
      ['d', 'e', 'f'].map(k => p[k])
    );
  });
});
