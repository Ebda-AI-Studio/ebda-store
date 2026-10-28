// Opus review fixes (DO checkout): inactive variants, backorder of a product without variants.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { placeOrder, type CheckoutInput } from '../src/do/checkout';
import { applyGoldRates } from '../src/do/gold-rates';
import { computeGoldUnitPrice } from '../../shared/src/commerce/gold-price';
import type { MoneyError } from '../src/do/sync-sql';

function fx() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  raw.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status, allow_backorder) VALUES ('bo', 's1', 'Backorderable', 'bo', 1000, 2, 'active', 1), ('nobo', 's1', 'Strict', 'nobo', 1000, 2, 'active', 0), ('vprod', 's1', 'Shirt', 'shirt', 0, 0, 'active', 0)`
  );
  raw.exec(
    `INSERT INTO product_variants (id, product_id, title, price, inventory, is_active) VALUES ('on', 'vprod', 'M', 4000, 3, 1), ('off', 'vprod', 'L', 4000, 3, 0)`
  );
  const base = (over: Partial<CheckoutInput> = {}): CheckoutInput => ({
    storeId: 's1',
    lines: [{ productId: 'bo', quantity: 1 }],
    shippingAddress: { name: 'A' },
    ...over,
  });
  const one = (q: string) => raw.prepare(q).get() as Record<string, number>;
  return { raw, db, base, one };
}
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as MoneyError).code;
  }
  return 'NO_ERROR';
};

describe('review fixes', () => {
  it('a disabled variant cannot be sold and its stock does not move', () => {
    const f = fx();
    expect(
      code(() =>
        placeOrder(f.db, f.base({ lines: [{ productId: 'vprod', variantId: 'off', quantity: 1 }] }))
      )
    ).toBe('VARIANT_INACTIVE');
    expect(f.one(`SELECT inventory n FROM product_variants WHERE id='off'`).n).toBe(3);
    placeOrder(f.db, f.base({ lines: [{ productId: 'vprod', variantId: 'on', quantity: 1 }] }));
    expect(f.one(`SELECT inventory n FROM product_variants WHERE id='on'`).n).toBe(2);
  });

  it('a product without variants backorders only with the store feature AND the product flag; stock goes negative, a backorder line is written', () => {
    const f = fx();
    const want = (productId: string, backorderEnabled?: boolean) =>
      f.base({ lines: [{ productId, quantity: 5 }], backorderEnabled });
    expect(code(() => placeOrder(f.db, want('bo')))).toBe('OUT_OF_STOCK'); // feature off
    expect(code(() => placeOrder(f.db, want('nobo', true)))).toBe('OUT_OF_STOCK'); // product flag off
    expect(f.one(`SELECT inventory n FROM products WHERE id='bo'`).n).toBe(2);
    const o = placeOrder(f.db, want('bo', true));
    expect(f.one(`SELECT inventory n FROM products WHERE id='bo'`).n).toBe(-3);
    expect(f.one(`SELECT stock_taken n FROM backorder_lines`).n).toBe(5);
    expect(
      f.one(`SELECT cost_price_deferred n FROM order_items WHERE order_id='${o.orderId}'`).n
    ).toBe(1);
    expect(f.one(`SELECT count(*) n FROM inventory_history WHERE reason = 'backorder'`).n).toBe(1);
  });

  it('a gold line is charged the GROUP price (percent_off), the snapshot keeps the list rate maths', () => {
    const f = fx();
    const SPEC = {
      karat: 21 as const,
      weightMg: 10_000,
      makingChargeType: 'fixed' as const,
      makingChargeValue: 50_000,
      marginBps: 500,
    };
    f.raw.exec(`INSERT OR REPLACE INTO do_flags (name, value) VALUES ('gold_reprice', 1)`);
    f.raw.exec(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status, pricing_mode, gold_karat, gold_weight_mg, making_charge_type, making_charge_value, gold_margin_bps) VALUES ('ring', 's1', 'Ring', 'ring', 1, 5, 'active', 'gold_rate', 21, 10000, 'fixed', 50000, 500)`
    );
    f.raw.exec(`UPDATE do_flags SET value = 0 WHERE name = 'gold_reprice'`);
    applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 300_000 }] },
      { userId: 'u' },
      { now: Date.now() }
    );
    f.raw.exec(
      `INSERT INTO customer_groups (id, store_id, name, pricing_mode, discount_bps, is_active, is_wholesale) VALUES ('g', 's1', 'G', 'percent_off', 1000, 1, 0)`
    );
    f.raw.exec(
      `INSERT INTO customers (id, store_id, first_name, last_name, user_id, group_id) VALUES ('c', 's1', 'A', 'B', 'u1', 'g')`
    );
    const list = computeGoldUnitPrice(SPEC, 300_000, 100).unitPrice;
    const o = placeOrder(
      f.db,
      f.base({
        lines: [{ productId: 'ring', quantity: 1, quotedUnitPrice: list }],
        buyer: { kind: 'session', userId: 'u1' },
        customerId: 'c',
        wholesaleEntitled: true,
      })
    );
    const group = Math.floor((list * 9000 + 5000) / 10000);
    expect(f.one(`SELECT price n FROM order_items WHERE order_id='${o.orderId}'`).n).toBe(group);
    expect(group).toBeLessThan(list);
    expect(o.subtotal).toBe(group);
  });
});
