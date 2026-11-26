/**
 * INV-AUDIT-4: the reorder projection's demand signal counts every order that is not cancelled / refunded, whatever its payment
 * status (a COD order stays `unpaid` until delivery settles it, MONEYB-7, so the old `paid`-only filter understated a COD
 * store's velocity), net of units already taken back by COMPLETED returns. Runs the real DO query layer (prisma-lite over the
 * StoreDO SQLite schema), the path every DO store takes.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@ebda/database', async () => ({
  ...(await import('./helpers/database-mock')).databaseMock({ prisma: {} }),
}));
vi.mock('../../apps/api/src/lib/repo-factory', () => ({ storeMoney: vi.fn(), storeDb: vi.fn() }));
vi.mock('../../apps/api/src/services/accounting/gemini-ai.service', () => ({
  callGemini: vi.fn(),
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sumOrderQty } from '../../apps/api/src/services/accounting/reorder-scan.service';
import { META, openSqlite } from '../../packages/repo/test/diff-harness';
import { createPrismaLite } from '../../packages/repo/src/prisma-lite/client';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';

const day = 24 * 60 * 60 * 1000;

function world() {
  const raw = openSqlite();
  raw.exec(`
    INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES
      ('p1', 's1', 'Plain', 'plain', 1000, 10, 'active'), ('pv', 's1', 'Shirt', 'shirt', 0, 0, 'active');
    INSERT INTO product_variants (id, product_id, title, price, inventory) VALUES ('v1', 'pv', 'M', 100, 3), ('v2', 'pv', 'L', 100, 4);
  `);
  const now = Date.now();
  let n = 0;
  const order = (status: string, pay: string, qty: number, ageDays: number, variantId?: string) => {
    const id = `o${++n}`;
    raw
      .prepare(
        `INSERT INTO orders (id, store_id, order_number, status, payment_status, subtotal, total, shipping_address, billing_address, created_at, updated_at) VALUES (?, 's1', ?, ?, ?, 1000, 1000, '{}', '{}', ?, ?)`
      )
      .run(id, id, status, pay, now - ageDays * day, now - ageDays * day);
    raw
      .prepare(
        `INSERT INTO order_items (id, order_id, product_id, variant_id, product_name, price, quantity, total) VALUES (?, ?, ?, ?, 'x', 1000, ?, 1000)`
      )
      .run(`i${n}`, id, variantId ? 'pv' : 'p1', variantId ?? null, qty);
    return `i${n}`;
  };
  const ret = (orderItemId: string, productId: string, qty: number, status = 'completed') => {
    const id = `r${++n}`;
    raw
      .prepare(
        `INSERT INTO returns (id, store_id, order_id, customer_id, return_number, type, status, reason, refund_amount, created_at, updated_at) VALUES (?, 's1', (SELECT order_id FROM order_items WHERE id = ?), 'c1', ?, 'return', ?, 'x', 0, ?, ?)`
      )
      .run(id, orderItemId, id, status, Date.now(), Date.now());
    raw
      .prepare(
        `INSERT INTO return_items (id, return_id, order_item_id, product_id, product_name, quantity) VALUES (?, ?, ?, ?, 'x', ?)`
      )
      .run(`ri${n}`, id, orderItemId, productId, qty);
  };
  const tx = createPrismaLite(META, nodeSqlRunner(raw), 'store-do', { unscoped: true }) as any;
  return {
    raw,
    order,
    ret,
    tx,
    sum: (variantId: string | null = null, days = 28) =>
      sumOrderQty(variantId ? 'pv' : 'p1', variantId, 's1', days, tx, true),
  };
}

describe('reorder demand (INV-AUDIT-4)', () => {
  it('counts COD (unpaid) and paid orders, not cancelled or refunded ones', async () => {
    const w = world();
    w.order('pending', 'unpaid', 4, 2); // COD, not yet delivered
    w.order('delivered', 'paid', 3, 3);
    w.order('confirmed', 'unpaid', 2, 1); // COD confirmed
    w.order('cancelled', 'unpaid', 50, 2);
    w.order('refunded', 'refunded', 50, 2);
    expect(await w.sum()).toBe(9);
  });

  it('nets out units taken back by COMPLETED returns only, and respects the window', async () => {
    const w = world();
    const i = w.order('delivered', 'paid', 5, 3);
    w.ret(i, 'p1', 2); // completed: 2 units are back on the shelf
    w.ret(i, 'p1', 1, 'pending'); // not completed: still demand
    w.order('delivered', 'paid', 7, 20); // outside the 7-day window
    expect(await w.sum(null, 28)).toBe(5 - 2 + 7);
    expect(await w.sum(null, 7)).toBe(3);
  });

  it('a variant unit counts only its own sales and returns', async () => {
    const w = world();
    const a = w.order('pending', 'unpaid', 4, 1, 'v1');
    w.order('pending', 'unpaid', 6, 1, 'v2');
    w.ret(a, 'pv', 1);
    expect(await w.sum('v1')).toBe(3);
    expect(await w.sum('v2')).toBe(6);
  });
});
