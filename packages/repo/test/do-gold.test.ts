// DO port of the gold-rate pricing gate (node:sqlite on the real StoreDO schema), diffed against the shared pricing maths.
import { describe, expect, it, vi } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { MoneyError } from '../src/do/sync-sql';
import {
  assertGoldLinesPriceable,
  assertSameGoldRates,
  computeGoldUnitPrice as computePort,
  resolveVariantGoldSpec as resolvePort,
  type GoldGateLine,
  type GoldPriceSpec,
} from '../src/do/gold';
import { computeGoldUnitPrice, resolveVariantGoldSpec } from '../../shared/src/commerce/gold-price';

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const MIN = 60_000;
const SPEC: GoldPriceSpec = {
  karat: 21,
  weightMg: 10_000,
  makingChargeType: 'fixed',
  makingChargeValue: 50_000,
  marginBps: 500,
};
const RATE21 = 300_000;
const price = (spec = SPEC, rate = RATE21, step: 1 | 100 | 500 | 1000 = 100) =>
  computeGoldUnitPrice(spec, rate, step).unitPrice;

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const err = (fn: () => unknown): MoneyError => {
  try {
    fn();
  } catch (e) {
    return e as MoneyError;
  }
  throw new Error('expected a MoneyError');
};

function fx() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  const setRate = (
    karat: number,
    rate: number,
    appliedAt = NOW - 10 * MIN,
    store = 's1',
    id?: string
  ) => {
    const rid = id ?? `r-${store}-${karat}-${appliedAt}`;
    raw
      .prepare(
        `INSERT OR IGNORE INTO gold_rates (id, store_id, karat, rate_per_gram, source, status, applied_at) VALUES (?,?,?,?,?,?,?)`
      )
      .run(rid, store, karat, rate, 'manual', 'applied', appliedAt);
    raw
      .prepare(`DELETE FROM gold_rates_current WHERE store_id = ? AND karat = ?`)
      .run(store, karat);
    raw
      .prepare(
        `INSERT INTO gold_rates_current (store_id, karat, rate_id, rate_per_gram, applied_at) VALUES (?,?,?,?,?)`
      )
      .run(store, karat, rid, rate, appliedAt);
    return rid;
  };
  const settings = (o: { maxAge?: number; step?: number } = {}) =>
    raw
      .prepare(
        `INSERT INTO gold_rate_settings (store_id, max_age_minutes, rounding_step) VALUES ('s1', ?, ?)`
      )
      .run(o.maxAge ?? 1560, o.step ?? 100);
  const product = (
    id: string,
    o: Partial<{
      store: string;
      price: number;
      mode: string;
      spec: Partial<GoldPriceSpec> | null;
    }> = {}
  ) => {
    const s = o.spec === null ? null : { ...SPEC, ...o.spec };
    const gold = (o.mode ?? 'gold_rate') === 'gold_rate';
    raw
      .prepare(
        `INSERT INTO products (id, store_id, name, slug, price, inventory, status, pricing_mode, gold_karat, gold_weight_mg, making_charge_type, making_charge_value, gold_margin_bps) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        o.store ?? 's1',
        id,
        id,
        o.price ?? (gold && s ? price(s as GoldPriceSpec) : 1500),
        5,
        'active',
        o.mode ?? 'gold_rate',
        s?.karat ?? null,
        s?.weightMg ?? null,
        s?.makingChargeType ?? null,
        s?.makingChargeValue ?? null,
        s?.marginBps ?? 0
      );
  };
  const variant = (
    id: string,
    productId: string,
    o: Partial<{
      price: number | null;
      mode: string | null;
      weight: number | null;
      karat: number | null;
    }> = {}
  ) =>
    raw
      .prepare(
        `INSERT INTO product_variants (id, product_id, title, price, inventory, pricing_mode, gold_weight_mg, gold_karat) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        productId,
        id,
        o.price ?? null,
        3,
        o.mode ?? null,
        o.weight ?? null,
        o.karat ?? null
      );
  const line = (productId: string, o: Partial<GoldGateLine> = {}): GoldGateLine => ({
    key: o.key ?? productId,
    productId,
    variantId: null,
    materialisedUnitPrice: price(),
    quotedUnitPrice: null,
    ...o,
  });
  return { raw, db, setRate, settings, product, variant, line };
}
const gate = (
  f: ReturnType<typeof fx>,
  lines: GoldGateLine[],
  o: { requireQuote?: boolean } = {}
) =>
  assertGoldLinesPriceable(f.db, 's1', lines, { requireQuote: o.requireQuote ?? false, now: NOW });

describe('gold gate: pricing from the current rate', () => {
  it('re-derives the price from the CURRENT rate and returns a valid gold_snapshot JSON', () => {
    const f = fx();
    const rid = f.setRate(21, RATE21);
    f.product('ring');
    const g = gate(f, [f.line('ring')]);
    expect(g.unitPrices.get('ring')).toBe(price());
    const snap = JSON.parse(g.snapshotJson.get('ring')!);
    expect(snap).toEqual({
      v: 1,
      karat: 21,
      weightMg: 10_000,
      ratePerGram: RATE21,
      rateId: rid,
      rateAppliedAt: new Date(NOW - 10 * MIN).toISOString(),
      makingChargeType: 'fixed',
      makingChargeValue: 50_000,
      marginBps: 500,
      roundingStep: 100,
      unitPrice: price(),
    });
    expect(g.rateIds.get(21)).toBe(rid);
    expect(g.roundingStep).toBe(100);
    // the snapshot is a JSON object the order_items CHECKs accept
    f.raw.exec(
      `INSERT INTO orders (id, store_id, order_number, subtotal, total, shipping_address, billing_address) VALUES ('o1','s1','1',1,1,'{}','{}')`
    );
    f.raw
      .prepare(
        `INSERT INTO order_items (id, order_id, product_id, product_name, price, quantity, total, gold_snapshot) VALUES ('i1','o1','ring','n',?,1,?,?)`
      )
      .run(price(), price(), g.snapshotJson.get('ring')!);
  });

  it('every rounding step (1 / 100 / 500 / 1000) prices through the store setting', () => {
    for (const step of [1, 100, 500, 1000] as const) {
      const f = fx();
      f.setRate(21, 301_234);
      f.settings({ step });
      const p = price(SPEC, 301_234, step);
      f.product('ring', { price: p });
      const g = gate(f, [f.line('ring', { materialisedUnitPrice: p })]);
      expect(g.unitPrices.get('ring')).toBe(p);
      expect(p % step).toBe(0);
      expect(g.roundingStep).toBe(step);
    }
  });

  it('a store with no settings row uses the defaults (26 h, step 100)', () => {
    const f = fx();
    f.setRate(21, RATE21, NOW - 1559 * MIN);
    f.product('ring');
    expect(gate(f, [f.line('ring')]).roundingStep).toBe(100);
  });

  it('fixed-price lines are never touched, in a mixed cart too (no rate is required for them)', () => {
    const f = fx();
    f.product('plain', { mode: 'fixed', spec: null, price: 1500 });
    expect(gate(f, [f.line('plain', { materialisedUnitPrice: 1500 })]).snapshots.size).toBe(0);
    f.setRate(21, RATE21);
    f.product('ring');
    const g = gate(f, [f.line('plain', { materialisedUnitPrice: 1500 }), f.line('ring')]);
    expect([...g.snapshots.keys()]).toEqual(['ring']);
  });

  it('a variant inherits the product spec; its own price is the one compared; a fixed variant is skipped', () => {
    const f = fx();
    f.setRate(21, RATE21);
    f.product('ring');
    f.variant('v-inherit', 'ring', { price: price() });
    f.variant('v-heavy', 'ring', { weight: 20_000, price: price({ ...SPEC, weightMg: 20_000 }) });
    f.variant('v-fixed', 'ring', { mode: 'fixed', price: 777 });
    expect(gate(f, [f.line('ring', { variantId: 'v-inherit' })]).unitPrices.get('ring')).toBe(
      price()
    );
    expect(
      gate(f, [
        f.line('ring', {
          key: 'heavy',
          variantId: 'v-heavy',
          materialisedUnitPrice: price({ ...SPEC, weightMg: 20_000 }),
        }),
      ]).unitPrices.get('heavy')
    ).toBe(price({ ...SPEC, weightMg: 20_000 }));
    expect(
      gate(f, [f.line('ring', { variantId: 'v-fixed', materialisedUnitPrice: 777 })]).snapshots.size
    ).toBe(0);
  });
});

describe('gold gate: stale rate', () => {
  it('stale from the minute the age EQUALS the max age; one minute less still sells', () => {
    for (const [age, stale] of [
      [1559, false],
      [1560, true],
      [1561, true],
    ] as const) {
      const f = fx();
      f.setRate(21, RATE21, NOW - age * MIN);
      f.product('ring');
      if (stale) {
        const e = err(() => gate(f, [f.line('ring')]));
        expect(e).toMatchObject({ code: 'GOLD_RATE_STALE', status: 409 });
        expect(e.meta).toMatchObject({
          maxAgeMinutes: 1560,
          karats: [{ karat: 21, ageMinutes: age }],
        });
      } else expect(gate(f, [f.line('ring')]).snapshots.size).toBe(1);
    }
  });

  it('honours the store max age (60 min floor) and counts whole minutes', () => {
    const f = fx();
    f.settings({ maxAge: 60 });
    f.setRate(21, RATE21, NOW - (59 * MIN + 59_999));
    f.product('ring');
    expect(gate(f, [f.line('ring')]).snapshots.size).toBe(1);
    f.setRate(21, RATE21, NOW - 60 * MIN, 's1', 'r-b');
    expect(err(() => gate(f, [f.line('ring')])).code).toBe('GOLD_RATE_STALE');
  });

  it('a MISSING rate for a needed karat is the same condition (ageMinutes null); a future applied_at reads as fresh', () => {
    const f = fx();
    f.setRate(24, 350_000);
    f.product('ring');
    expect(err(() => gate(f, [f.line('ring')])).meta).toMatchObject({
      karats: [{ karat: 21, ageMinutes: null }],
    });
    f.setRate(21, RATE21, NOW + 5 * MIN);
    expect(gate(f, [f.line('ring')]).snapshots.size).toBe(1);
  });

  it("another store's rate is never used", () => {
    const f = fx();
    f.setRate(21, RATE21, NOW - MIN, 's2');
    f.product('ring');
    expect(err(() => gate(f, [f.line('ring')])).code).toBe('GOLD_RATE_STALE');
  });
});

describe('gold gate: drift and moved prices', () => {
  it('a stored price that differs from the recomputed one is GOLD_PRICE_DRIFT (and raises the alert hook)', () => {
    const f = fx();
    f.setRate(21, RATE21);
    f.product('ring', { price: price() + 1 });
    const onDrift = vi.fn();
    const e = err(() =>
      assertGoldLinesPriceable(f.db, 's1', [f.line('ring')], {
        requireQuote: false,
        now: NOW,
        onDrift,
      })
    );
    expect(e).toMatchObject({ code: 'GOLD_PRICE_DRIFT', status: 409 });
    expect(onDrift).toHaveBeenCalledWith([
      { productId: 'ring', variantId: null, materialised: price() + 1, expected: price() },
    ]);
  });

  it('a caller price older than the live one is PRICE_CHANGED with previous/current', () => {
    const f = fx();
    f.setRate(21, RATE21);
    f.product('ring');
    const e = err(() => gate(f, [f.line('ring', { materialisedUnitPrice: price() - 100 })]));
    expect(e).toMatchObject({ code: 'PRICE_CHANGED', status: 409 });
    expect(e.meta?.lines).toEqual([
      { productId: 'ring', variantId: null, previous: price() - 100, current: price() },
    ]);
  });

  it('the shopper quote is compared only with requireQuote', () => {
    const f = fx();
    f.setRate(21, RATE21);
    f.product('ring');
    const l = f.line('ring', { quotedUnitPrice: price() - 5 });
    expect(gate(f, [l]).snapshots.size).toBe(1);
    expect(err(() => gate(f, [l], { requireQuote: true })).code).toBe('PRICE_CHANGED');
    expect(
      gate(f, [f.line('ring', { quotedUnitPrice: price() })], { requireQuote: true }).snapshots.size
    ).toBe(1);
    expect(
      gate(f, [f.line('ring', { quotedUnitPrice: null })], { requireQuote: true }).snapshots.size
    ).toBe(1);
  });

  it('one moved line refuses the whole order', () => {
    const f = fx();
    f.setRate(21, RATE21);
    f.product('a');
    f.product('b');
    const e = err(() => gate(f, [f.line('a'), f.line('b', { materialisedUnitPrice: 1 })]));
    expect(e.code).toBe('PRICE_CHANGED');
    expect((e.meta?.lines as unknown[]).length).toBe(1);
  });

  it('a gold row with an incomplete spec is GOLD_SPEC_INVALID, never a guessed price', () => {
    const f = fx();
    f.setRate(21, RATE21);
    f.product('ring');
    // the schema CHECKs a complete spec, so write the broken row past it: the gate must still refuse
    f.raw.exec(`PRAGMA ignore_check_constraints = 1`);
    f.raw.exec(`UPDATE products SET gold_weight_mg = NULL WHERE id = 'ring'`);
    expect(err(() => gate(f, [f.line('ring')])).code).toBe('GOLD_SPEC_INVALID');
  });

  it("another store's product is not priced here (checkout's own product lookup rejects it)", () => {
    const f = fx();
    f.setRate(21, RATE21);
    f.product('theirs', { store: 's2' });
    expect(gate(f, [f.line('theirs')]).snapshots.size).toBe(0);
  });
});

describe('gold gate: hostile input', () => {
  it('refuses malformed lines, ids, prices and clock', () => {
    const f = fx();
    const ok = f.line('ring');
    const bad: unknown[] = [
      { ...ok, key: '' },
      { ...ok, productId: 5 },
      { ...ok, variantId: undefined },
      { ...ok, materialisedUnitPrice: 1.5 },
      { ...ok, materialisedUnitPrice: -1 },
      { ...ok, materialisedUnitPrice: 2 ** 40 },
      { ...ok, quotedUnitPrice: NaN },
      { ...ok, productId: 'x'.repeat(201) },
      null,
    ];
    for (const b of bad) expect(err(() => gate(f, [b as GoldGateLine])).code).toBe('INVALID_INPUT');
    expect(err(() => gate(f, new Array(501).fill(ok))).code).toBe('INVALID_INPUT');
    expect(err(() => assertGoldLinesPriceable(f.db, '', [ok], { requireQuote: false })).code).toBe(
      'INVALID_INPUT'
    );
    expect(
      err(() => assertGoldLinesPriceable(f.db, 's1', [ok], { requireQuote: false, now: -1 })).code
    ).toBe('INVALID_INPUT');
    expect(gate(f, []).snapshots.size).toBe(0);
  });

  it('SQL metacharacters in ids are bound parameters', () => {
    const f = fx();
    f.setRate(21, RATE21);
    f.product('ring');
    expect(gate(f, [f.line(`ring' OR '1'='1`)]).snapshots.size).toBe(0);
  });

  it('a corrupt settings row fails closed', () => {
    const f = fx();
    f.setRate(21, RATE21);
    f.product('ring');
    f.settings();
    f.raw.exec(`PRAGMA ignore_check_constraints = 1`);
    f.raw.exec(`UPDATE gold_rate_settings SET max_age_minutes = 99999`);
    expect(err(() => gate(f, [f.line('ring')])).code).toBe('GOLD_SETTINGS_CORRUPT');
  });
});

describe('gold gate: assertSameGoldRates (rate moved after pricing)', () => {
  const priced = () => {
    const f = fx();
    f.setRate(21, RATE21);
    f.product('ring');
    return { f, g: gate(f, [f.line('ring')]) };
  };
  it('passes while nothing moved', () => {
    const { f, g } = priced();
    expect(() => assertSameGoldRates(f.db, 's1', g)).not.toThrow();
  });
  it('a newer rate row is PRICE_CHANGED with the karat', () => {
    const { f, g } = priced();
    f.setRate(21, RATE21 + 1, NOW - MIN, 's1', 'r-new');
    const e = err(() => assertSameGoldRates(f.db, 's1', g));
    expect(e).toMatchObject({ code: 'PRICE_CHANGED' });
    expect(e.meta).toMatchObject({ karat: 21 });
  });
  it('a changed rounding step, weight or making charge is PRICE_CHANGED', () => {
    for (const sql of [
      `INSERT INTO gold_rate_settings (store_id, rounding_step) VALUES ('s1', 500)`,
      `UPDATE products SET gold_weight_mg = 10001 WHERE id = 'ring'`,
      `UPDATE products SET making_charge_value = 1 WHERE id = 'ring'`,
      `UPDATE products SET gold_margin_bps = 0 WHERE id = 'ring'`,
      `UPDATE products SET price = price + 1 WHERE id = 'ring'`,
    ]) {
      const { f, g } = priced();
      f.raw.exec(sql);
      expect(err(() => assertSameGoldRates(f.db, 's1', g)).code).toBe('PRICE_CHANGED');
    }
  });
});

describe('gold: diff against the shared pricing maths', () => {
  it('computeGoldUnitPrice matches over generated specs, rates and steps (values and error codes)', () => {
    const r = rng(7);
    const steps = [1, 100, 500, 1000] as const;
    const pickInt = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
    for (let i = 0; i < 3000; i++) {
      const wild = r() < 0.15;
      const spec = {
        karat: ([24, 21, 18, 22] as const)[pickInt(0, wild ? 3 : 2)]!,
        weightMg: wild ? pickInt(-5, 1_000_005) : pickInt(1, 1_000_000),
        makingChargeType: (['fixed', 'per_gram'] as const)[pickInt(0, 1)]!,
        makingChargeValue: pickInt(0, wild ? 3_000_000_000 : 200_000),
        marginBps: wild ? pickInt(-6000, 11000) : pickInt(-5000, 10000),
      } as GoldPriceSpec;
      const rate = wild ? pickInt(0, 11_000_000) : pickInt(10_000, 10_000_000);
      const step = steps[pickInt(0, 3)]!;
      let a: unknown;
      let b: unknown;
      try {
        a = computeGoldUnitPrice(spec, rate, step);
      } catch (e) {
        a = (e as { code: string }).code;
      }
      try {
        b = computePort(spec, rate, step);
      } catch (e) {
        b = (e as { code: string }).code;
      }
      expect(b).toEqual(a);
    }
  });

  it('resolveVariantGoldSpec matches (inheritance, null margin, incomplete specs)', () => {
    const r = rng(8);
    const maybe = <T>(v: T): T | null => (r() < 0.4 ? null : v);
    const fields = () => ({
      karat: maybe(([24, 21, 18] as const)[Math.floor(r() * 3)]!),
      weightMg: maybe(1 + Math.floor(r() * 50_000)),
      makingChargeType: maybe((['fixed', 'per_gram'] as const)[Math.floor(r() * 2)]!),
      makingChargeValue: maybe(Math.floor(r() * 9000)),
      marginBps: maybe(Math.floor(r() * 1000)),
    });
    for (let i = 0; i < 1500; i++) {
      const p = {
        pricingMode: (r() < 0.8 ? 'gold_rate' : 'fixed') as 'gold_rate' | 'fixed',
        ...fields(),
      };
      const v = {
        pricingMode: maybe((r() < 0.8 ? 'gold_rate' : 'fixed') as 'gold_rate' | 'fixed'),
        ...fields(),
      };
      const run = (fn: typeof resolveVariantGoldSpec) => {
        try {
          return fn(p, v);
        } catch (e) {
          return (e as { code: string }).code;
        }
      };
      expect(run(resolvePort as typeof resolveVariantGoldSpec)).toEqual(
        run(resolveVariantGoldSpec)
      );
    }
  });

  it('rounding steps: half rounds UP to the step (known vectors)', () => {
    // exact 1 piastre price, then steps: 123_456 piastres at step 500 -> 123_500 ; 123_249 -> 123_000 (half-up at 250)
    const spec: GoldPriceSpec = {
      ...SPEC,
      makingChargeType: 'fixed',
      makingChargeValue: 0,
      marginBps: 0,
      weightMg: 1000,
    };
    // 1 g at rate R is exactly R piastres
    expect(computePort(spec, 123_250, 500).unitPrice).toBe(123_500);
    expect(computePort(spec, 123_249, 500).unitPrice).toBe(123_000);
    expect(computePort(spec, 123_450, 100).unitPrice).toBe(123_500);
    expect(computePort(spec, 123_449, 100).unitPrice).toBe(123_400);
    expect(computePort(spec, 123_456, 1).unitPrice).toBe(123_456);
    expect(computePort(spec, 125_000, 1000).unitPrice).toBe(125_000);
    expect(computePort(spec, 124_999, 1000).unitPrice).toBe(125_000);
    expect(computePort(spec, 124_499, 1000).unitPrice).toBe(124_000);
  });
});
