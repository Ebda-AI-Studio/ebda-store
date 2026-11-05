// PR D2b-5 (Ruling CF-LAST-1): product pricing edits (setProductPricing, bulkSwitchMode, the asRepricer pre-check) as named
// money operations on the real DO schema (node:sqlite).
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureMoneyOpsSchema, MONEY_OP_NAMES, runMoneyOp } from '../src/do/money-ops';
import { MoneyError } from '../src/do/sync-sql';

const S = 's1';
function rig(opts: { rate?: boolean } = {}) {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  if (opts.rate !== false)
    raw.exec(
      `INSERT INTO gold_rates (id, store_id, karat, rate_per_gram, source, status, created_at, applied_at) VALUES ('r21','s1',21,576000,'manual','applied',1,1);
       INSERT INTO gold_rates_current (store_id, karat, rate_id, rate_per_gram, applied_at) VALUES ('s1',21,'r21',576000,1);`
    );
  const q = (sql: string, ...p: unknown[]) => raw.prepare(sql).all(...(p as never[])) as any[];
  const op = (name: string, args: Record<string, unknown>, key?: string) =>
    runMoneyOp(db, S, name, args, key) as any;
  const code = (name: string, args: Record<string, unknown>): string => {
    try {
      op(name, args);
    } catch (e) {
      return `${(e as MoneyError).code}/${(e as MoneyError).status}`;
    }
    return 'no error';
  };
  const product = (id: string, extra = '') =>
    raw.exec(
      `INSERT INTO products (id, store_id, name, slug, price, status, compare_at_price ${extra ? ',' + extra.split('|')[0] : ''}) VALUES ('${id}','s1','P','${id}',1000,'active',500 ${extra ? ',' + extra.split('|')[1] : ''})`
    );
  return { raw, db, q, op, code, product };
}
const GOLD = {
  pricingMode: 'gold_rate',
  karat: 21,
  weightMg: 3250,
  makingChargeType: 'per_gram',
  makingChargeValue: 15_000,
  marginBps: 0,
};

describe('goldSetProductPricing', () => {
  it('is registered', () => {
    expect(MONEY_OP_NAMES).toEqual(
      expect.arrayContaining(['goldSetProductPricing', 'goldBulkSwitchMode', 'goldCreateVariant'])
    );
  });

  it('fixed -> gold prices the product, clears compare-at, and leaves the guard flag off', () => {
    const r = rig();
    r.product('a');
    const out = r.op('goldSetProductPricing', { productId: 'a', product: GOLD });
    expect(out).toMatchObject({ pricingMode: 'gold_rate', from: 'fixed' });
    const p = r.q("SELECT price, compare_at_price, gold_karat FROM products WHERE id='a'")[0];
    expect(p.price).toBe(out.price);
    expect(p.price).toBeGreaterThan(1000);
    expect(p.compare_at_price).toBeNull();
    expect(r.q("SELECT value FROM do_flags WHERE name='gold_reprice'")[0].value).toBe(0);
  });

  it('a missing rate is GOLD_RATE_MISSING 409 and writes nothing', () => {
    const r = rig({ rate: false });
    r.product('a');
    expect(r.code('goldSetProductPricing', { productId: 'a', product: GOLD })).toBe(
      'GOLD_RATE_MISSING/409'
    );
    expect(r.q("SELECT pricing_mode FROM products WHERE id='a'")[0].pricing_mode).toBe('fixed');
  });

  it('unknown product / variant are 404; a bundled product and a tiered one are refused', () => {
    const r = rig();
    r.product('a');
    expect(r.code('goldSetProductPricing', { productId: 'zz', product: GOLD })).toBe(
      'NOT_FOUND/404'
    );
    expect(
      r.code('goldSetProductPricing', {
        productId: 'a',
        product: GOLD,
        variants: [{ id: 'nope', pricingMode: null }],
      })
    ).toBe('NOT_FOUND/404');
    r.raw.exec(
      `INSERT INTO bundles (id, store_id, name, slug, pricing_type, pricing_value) VALUES ('b','s1','B','b','fixed_price',1);
       INSERT INTO bundle_items (id, bundle_id, product_id, quantity) VALUES ('bi','b','a',1)`
    );
    expect(r.code('goldSetProductPricing', { productId: 'a', product: GOLD })).toBe(
      'GOLD_IN_BUNDLE/409'
    );
    r.product('t');
    r.raw.exec(
      `INSERT INTO product_price_tiers (id, store_id, product_id, min_qty, price_minor) VALUES ('t1','s1','t',5,900)`
    );
    expect(r.code('goldSetProductPricing', { productId: 't', product: GOLD })).toBe(
      'GOLD_NO_PRICE_TIERS/409'
    );
  });

  it('a fixed variant without its own price under a gold product is GOLD_VARIANT_NEEDS_PRICE', () => {
    const r = rig();
    r.product('a');
    r.raw.exec(`INSERT INTO product_variants (id, product_id, title) VALUES ('v1','a','V')`);
    expect(
      r.code('goldSetProductPricing', {
        productId: 'a',
        product: GOLD,
        variants: [{ id: 'v1', pricingMode: 'fixed' }],
      })
    ).toBe('GOLD_VARIANT_NEEDS_PRICE/409');
  });

  it('gold -> fixed freezes the computed price', () => {
    const r = rig();
    r.product('a');
    const g = r.op('goldSetProductPricing', { productId: 'a', product: GOLD });
    const f = r.op('goldSetProductPricing', { productId: 'a', product: { pricingMode: 'fixed' } });
    expect(f).toMatchObject({
      pricingMode: 'fixed',
      price: g.price,
      frozenPrice: g.price,
      from: 'gold_rate',
    });
  });

  it('refuses a bad spec at the door (weight not in 10 mg steps)', () => {
    const r = rig();
    r.product('a');
    expect(
      r.code('goldSetProductPricing', { productId: 'a', product: { ...GOLD, weightMg: 3255 } })
    ).toBe('VALIDATION_ERROR/400');
  });

  it('a keyed replay answers the first result and does not write again', () => {
    const r = rig();
    r.product('a');
    const one = r.op(
      'goldSetProductPricing',
      { productId: 'a', product: GOLD },
      'gold-key-0000000001'
    );
    r.raw.exec('UPDATE do_flags SET value = 0');
    r.raw.exec('UPDATE gold_rates_current SET rate_per_gram = 600000');
    const two = r.op(
      'goldSetProductPricing',
      { productId: 'a', product: GOLD },
      'gold-key-0000000001'
    );
    expect(two).toEqual(one);
  });
});

describe('goldBulkSwitchMode', () => {
  it('switches what it can and skips the rest with the reason, each product alone', () => {
    const r = rig();
    r.product(
      'ok',
      "gold_karat, gold_weight_mg, making_charge_type, making_charge_value|21, 3250, 'per_gram', 15000"
    );
    r.product('incomplete');
    r.product(
      'bundled',
      "gold_karat, gold_weight_mg, making_charge_type, making_charge_value|21, 3250, 'per_gram', 15000"
    );
    r.raw.exec(
      `INSERT INTO bundles (id, store_id, name, slug, pricing_type, pricing_value) VALUES ('b','s1','B','b','fixed_price',1);
       INSERT INTO bundle_items (id, bundle_id, product_id, quantity) VALUES ('bi','b','bundled',1)`
    );
    const out = r.op('goldBulkSwitchMode', {
      ids: ['ok', 'incomplete', 'bundled', 'ghost', 'ok'],
      mode: 'gold_rate',
    });
    expect(out.switched).toEqual(['ok']);
    expect(out.skipped).toEqual(
      expect.arrayContaining([
        { id: 'incomplete', reason: 'SPEC_INCOMPLETE' },
        { id: 'bundled', reason: 'GOLD_IN_BUNDLE' },
        { id: 'ghost', reason: 'NOT_FOUND' },
      ])
    );
    expect(r.q("SELECT pricing_mode FROM products WHERE id='bundled'")[0].pricing_mode).toBe(
      'fixed'
    );
    expect(r.op('goldBulkSwitchMode', { ids: ['ok'], mode: 'gold_rate' }).skipped).toEqual([
      { id: 'ok', reason: 'ALREADY' },
    ]);
    expect(r.op('goldBulkSwitchMode', { ids: ['ok'], mode: 'fixed' }).switched).toEqual(['ok']);
  });

  it('caps at 500 ids', () => {
    const r = rig();
    const ids = Array.from({ length: 600 }, (_, i) => `x${i}`);
    expect(r.op('goldBulkSwitchMode', { ids, mode: 'fixed' }).skipped).toHaveLength(500);
  });
});

describe('goldCreateVariant (the asRepricer closure)', () => {
  it('a variant of a gold product is born priced, with its option rows', () => {
    const r = rig();
    r.product('a');
    r.raw.exec(
      `INSERT INTO product_options (id, product_id, name, position) VALUES ('o','a','Size',0);
       INSERT INTO product_option_values (id, option_id, value, position) VALUES ('ov','o','M',0)`
    );
    r.op('goldSetProductPricing', { productId: 'a', product: GOLD });
    const { id } = r.op('goldCreateVariant', {
      productId: 'a',
      variant: { title: 'M', sku: 'S1' },
      optionValueIds: ['ov'],
    });
    const v = r.q('SELECT price, gold_rate_id, sku FROM product_variants WHERE id = ?', id)[0];
    expect(v.price).toBe(r.q("SELECT price FROM products WHERE id='a'")[0].price);
    expect(v.gold_rate_id).toBe('r21');
    expect(
      r.q('SELECT count(*) n FROM product_variant_options WHERE variant_id = ?', id)[0].n
    ).toBe(1);
    expect(r.q("SELECT value FROM do_flags WHERE name='gold_reprice'")[0].value).toBe(0);
  });
  it('a missing rate rolls the insert back (GOLD_RATE_MISSING 409)', () => {
    const r = rig();
    r.product('a');
    r.op('goldSetProductPricing', { productId: 'a', product: GOLD });
    r.raw.exec('DELETE FROM gold_rates_current');
    expect(
      r.code('goldCreateVariant', { productId: 'a', variant: { title: 'M' }, optionValueIds: [] })
    ).toBe('GOLD_RATE_MISSING/409');
    expect(r.q('SELECT count(*) n FROM product_variants')[0].n).toBe(0);
    expect(r.q("SELECT value FROM do_flags WHERE name='gold_reprice'")[0].value).toBe(0);
  });
  it('refuses a product that is not priced by gold', () => {
    const r = rig();
    r.product('a');
    expect(
      r.code('goldCreateVariant', { productId: 'a', variant: { title: 'M' }, optionValueIds: [] })
    ).toBe('GOLD_PRODUCT_REQUIRED/409');
  });
});
