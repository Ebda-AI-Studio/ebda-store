// Ruling SHARIA-GOLD-1 on the store Durable Object: the checkout twin of assertGoldPaymentAllowed.
// A gold cart with COD / an installment method is refused unless store_config.settings allows it.
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, runMoneyOp } from '../src/do/money-ops';
import { MoneyError } from '../src/do/sync-sql';
import { computeGoldUnitPrice } from '../../shared/src/commerce/gold-price';

const SPEC = {
  karat: 21,
  weightMg: 10_000,
  makingChargeType: 'fixed',
  makingChargeValue: 50_000,
  marginBps: 500,
} as const;
const RATE = 300_000;

function rig(allowDeferred?: boolean) {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  const appliedAt = Date.now() - 10 * 60_000;
  const goldPrice = computeGoldUnitPrice(SPEC, RATE, 100).unitPrice;
  raw.exec(
    `INSERT INTO gold_rates (id, store_id, karat, rate_per_gram, source, status, applied_at) VALUES ('r1','s1',21,${RATE},'manual','applied',${appliedAt});
     INSERT INTO gold_rates_current (store_id, karat, rate_id, rate_per_gram, applied_at) VALUES ('s1',21,'r1',${RATE},${appliedAt});
     INSERT INTO gold_rate_settings (store_id, max_age_minutes, rounding_step) VALUES ('s1',1560,100);
     INSERT INTO products (id, store_id, name, slug, price, inventory, status, track_inventory, pricing_mode, gold_karat, gold_weight_mg, making_charge_type, making_charge_value, gold_margin_bps) VALUES ('ring','s1','Ring','ring',${goldPrice},5,'active',1,'gold_rate',21,${SPEC.weightMg},'fixed',${SPEC.makingChargeValue},${SPEC.marginBps});
     INSERT INTO products (id, store_id, name, slug, price, inventory, status, track_inventory) VALUES ('mug','s1','Mug','mug',1500,5,'active',1)`
  );
  if (allowDeferred !== undefined)
    raw
      .prepare(`INSERT INTO store_config (store_id, settings) VALUES ('s1', ?)`)
      .run(JSON.stringify({ goldAllowDeferredPayment: allowDeferred }));
  const order = (productId: string, paymentMethod: string) =>
    runMoneyOp(db, 's1', 'createOrder', {
      lines: [{ productId, quantity: 1, quotedUnitPrice: productId === 'ring' ? goldPrice : null }],
      shippingAddress: { name: 'A' },
      paymentMethod,
    }) as { total: number };
  return { order };
}

const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof MoneyError ? e.code : 'other';
  }
  return null;
};

describe('gold + COD on the store DO', () => {
  it('is refused with the setting OFF (absent or false)', () => {
    expect(refused(() => rig().order('ring', 'cod'))).toBe('GOLD_PREPAID_ONLY');
    expect(refused(() => rig(false).order('ring', 'cod'))).toBe('GOLD_PREPAID_ONLY');
  });
  it('is accepted with the setting ON', () => {
    expect(refused(() => rig(true).order('ring', 'cod'))).toBeNull();
  });
  it('a prepaid online method on gold is accepted', () => {
    expect(refused(() => rig().order('ring', 'paymob'))).toBeNull();
  });
  it('a cart without gold is unchanged (COD works with the setting OFF)', () => {
    expect(refused(() => rig().order('mug', 'cod'))).toBeNull();
  });
});
