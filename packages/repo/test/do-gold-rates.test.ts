// Gold-rate WRITE path on the DO schema (node:sqlite): jump gate, pending feed rates, reprice, atomic rollback, guard flag.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import {
  applyGoldRates,
  decidePendingGoldRate,
  repriceGoldProduct,
  updateGoldSettings,
} from '../src/do/gold-rates';
import { assertGoldLinesPriceable } from '../src/do/gold';
import { computeGoldUnitPrice } from '../../shared/src/commerce/gold-price';
import type { MoneyError } from '../src/do/sync-sql';

const SPEC = {
  karat: 21 as const,
  weightMg: 10_000,
  makingChargeType: 'fixed' as const,
  makingChargeValue: 50_000,
  marginBps: 500,
};
const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);
let n = 0;
const ids = () => `id${++n}`;

function fx() {
  const raw = openSqlite();
  raw.exec(
    fs.readFileSync(
      new URL('../../cf-schema/migrations/store/0002_invariants.sql', import.meta.url),
      'utf8'
    )
  );
  const db = nodeSyncSql(raw);
  raw
    .prepare(
      `INSERT INTO gold_rate_settings (store_id, max_age_minutes, rounding_step) VALUES ('s1', 1560, 100)`
    )
    .run();
  const product = (
    id: string,
    o: { karat?: number; price?: number; store?: string; w?: number } = {}
  ) => {
    // gold rows can only be inserted under the repricer flag (the SQLite guard), exactly like production
    raw.exec(`INSERT OR REPLACE INTO do_flags (name, value) VALUES ('gold_reprice', 1)`);
    raw
      .prepare(
        `INSERT INTO products (id, store_id, name, slug, price, inventory, status, pricing_mode, gold_karat, gold_weight_mg, making_charge_type, making_charge_value, gold_margin_bps) VALUES (?,?,?,?,?,5,'active','gold_rate',?,?,?,?,?)`
      )
      .run(
        id,
        o.store ?? 's1',
        id,
        id,
        o.price ?? 1,
        o.karat ?? 21,
        o.w ?? 10_000,
        'fixed',
        50_000,
        500
      );
    raw.exec(`UPDATE do_flags SET value = 0 WHERE name = 'gold_reprice'`);
  };
  const price = (id: string) =>
    Number((raw.prepare(`SELECT price FROM products WHERE id = ?`).get(id) as any).price);
  const rate = (karat: number) =>
    raw
      .prepare(`SELECT rate_per_gram AS r FROM gold_rates_current WHERE store_id='s1' AND karat=?`)
      .get(karat) as any;
  return { raw, db, product, price, rate };
}
const expectPrice = (rate: number, step = 100 as const) =>
  computeGoldUnitPrice(SPEC, rate, step).unitPrice;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof Error && e.name === 'MoneyError'
      ? (e as MoneyError).code
      : (e as Error).message;
  }
  return 'NO_ERROR';
};

describe('applyGoldRates', () => {
  it('writes the rate, history row and reprices every gold product to the shared formula', () => {
    const f = fx();
    f.product('p1');
    f.product('p2', { karat: 21, w: 20_000 });
    const out = applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 300_000 }] },
      { userId: 'u' },
      { now: T0, newId: ids }
    );
    expect(out.applied).toHaveLength(1);
    expect(out.repriced).toBe(2);
    expect(f.price('p1')).toBe(expectPrice(300_000));
    expect(f.rate(21).r).toBe(300_000);
    expect(f.raw.prepare(`SELECT count(*) AS n FROM gold_rates`).get()).toEqual({ n: 1 });
  });

  it('only products of the written karat move; an untouched karat keeps its price', () => {
    const f = fx();
    f.product('k21', { karat: 21 });
    f.product('k18', { karat: 18, price: 777 });
    applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 300_000 }] },
      { userId: 'u' },
      { now: T0, newId: ids }
    );
    expect(f.price('k18')).toBe(777);
  });

  it('a jump over the gate needs confirm: 409, NOTHING written; with confirm it applies', () => {
    const f = fx();
    f.product('p1');
    applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 300_000 }] },
      { userId: 'u' },
      { now: T0, newId: ids }
    );
    const before = f.price('p1');
    expect(
      code(() =>
        applyGoldRates(
          f.db,
          's1',
          { rates: [{ karat: 21, ratePerGram: 400_000 }] },
          { userId: 'u' },
          { now: T0 + 1, newId: ids }
        )
      )
    ).toBe('GOLD_RATE_CONFIRM_REQUIRED');
    expect(f.rate(21).r).toBe(300_000);
    expect(f.price('p1')).toBe(before);
    expect(f.raw.prepare(`SELECT count(*) AS n FROM gold_rates`).get()).toEqual({ n: 1 });
    applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 400_000 }], confirm: true },
      { userId: 'u' },
      { now: T0 + 2, newId: ids }
    );
    expect(f.price('p1')).toBe(expectPrice(400_000));
  });

  it('a jump exactly at the gate passes, one bp over needs confirm (boundary, rounded up)', () => {
    const f = fx();
    applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 200_000 }] },
      { userId: 'u' },
      { now: T0, newId: ids }
    );
    // gate default 500 bps = 5%: 210_000 is exactly 500 bps
    expect(
      code(() =>
        applyGoldRates(
          f.db,
          's1',
          { rates: [{ karat: 21, ratePerGram: 210_000 }] },
          { userId: 'u' },
          { now: T0 + 1, newId: ids }
        )
      )
    ).toBe('NO_ERROR');
    expect(
      code(() =>
        applyGoldRates(
          f.db,
          's1',
          { rates: [{ karat: 21, ratePerGram: 220_501 }] },
          { userId: 'u' },
          { now: T0 + 2, newId: ids }
        )
      )
    ).toBe('GOLD_RATE_CONFIRM_REQUIRED');
  });

  it('karat coherence: 21k typed far from 24k*21/24 needs confirm', () => {
    const f = fx();
    expect(
      code(() =>
        applyGoldRates(
          f.db,
          's1',
          {
            rates: [
              { karat: 24, ratePerGram: 400_000 },
              { karat: 21, ratePerGram: 400_000 },
            ],
          },
          { userId: 'u' },
          { now: T0, newId: ids }
        )
      )
    ).toBe('GOLD_RATE_CONFIRM_REQUIRED');
    expect(
      code(() =>
        applyGoldRates(
          f.db,
          's1',
          {
            rates: [
              { karat: 24, ratePerGram: 400_000 },
              { karat: 21, ratePerGram: 350_000 },
            ],
          },
          { userId: 'u' },
          { now: T0, newId: ids }
        )
      )
    ).toBe('NO_ERROR');
  });

  it('a feed rate over the gate is stored PENDING, never current, never reprices; a newer one supersedes it', () => {
    const f = fx();
    f.product('p1');
    applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 300_000 }] },
      { userId: 'u' },
      { now: T0, newId: ids }
    );
    const p = applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 500_000 }] },
      { feed: { src: 'x' } },
      { now: T0 + 1, newId: ids }
    );
    expect(p.pending).toHaveLength(1);
    expect(p.repriced).toBe(0);
    expect(f.rate(21).r).toBe(300_000);
    applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 510_000 }] },
      { feed: { src: 'y' } },
      { now: T0 + 2, newId: ids }
    );
    const st = f.raw
      .prepare(
        `SELECT status, rate_per_gram AS r FROM gold_rates WHERE status IN ('pending','rejected') ORDER BY created_at`
      )
      .all() as any[];
    expect(st.map(x => x.status)).toEqual(['rejected', 'pending']);
  });

  it('a demo feed (skipJumpGate) applies a rate over the gate; forcePending still wins', () => {
    const f = fx();
    f.product('p1');
    applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 300_000 }] },
      { userId: 'u' },
      { now: T0, newId: ids }
    );
    const a = applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 500_000 }] },
      { feed: { src: 'x' }, skipJumpGate: true },
      { now: T0 + 1, newId: ids }
    );
    expect(a.pending).toHaveLength(0);
    expect(a.applied).toHaveLength(1);
    expect(f.rate(21).r).toBe(500_000);
    const p = applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 510_000 }] },
      { feed: { src: 'y' }, skipJumpGate: true, forcePending: true },
      { now: T0 + 2, newId: ids }
    );
    expect(p.pending).toHaveLength(1);
    expect(f.rate(21).r).toBe(500_000);
  });

  it('variants: variant priced by its resolved spec, product = minimum ACTIVE variant price', () => {
    const f = fx();
    f.product('p1');
    f.raw.exec(`INSERT OR REPLACE INTO do_flags (name, value) VALUES ('gold_reprice', 1)`);
    f.raw.exec(
      `INSERT INTO product_variants (id, product_id, title, price, inventory, pricing_mode, gold_weight_mg) VALUES ('vh','p1','h',1,1,'gold_rate',5000),('vl','p1','l',1,1,'gold_rate',20000),('vf','p1','f',123,1,'fixed',NULL)`
    );
    f.raw.exec(`UPDATE product_variants SET is_active = 0 WHERE id = 'vh'`);
    f.raw.exec(`UPDATE do_flags SET value = 0 WHERE name = 'gold_reprice'`);
    applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 300_000 }] },
      { userId: 'u' },
      { now: T0, newId: ids }
    );
    const vp = (id: string) =>
      Number((f.raw.prepare(`SELECT price FROM product_variants WHERE id=?`).get(id) as any).price);
    expect(vp('vh')).toBe(
      computeGoldUnitPrice({ ...SPEC, weightMg: 5000 }, 300_000, 100).unitPrice
    );
    expect(vp('vf')).toBe(123);
    // inactive cheapest variant is ignored: min over active {vl, vf=123}
    expect(f.price('p1')).toBe(Math.min(vp('vl'), 123));
  });

  it('the reprice is atomic: a failure midway leaves the old rate, old prices and no history', () => {
    const f = fx();
    f.product('a');
    f.product('b');
    applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 300_000 }] },
      { userId: 'u' },
      { now: T0, newId: ids }
    );
    const pa = f.price('a');
    f.raw.exec(
      `CREATE TRIGGER boom BEFORE UPDATE OF price ON products WHEN NEW.id = 'b' BEGIN SELECT RAISE(ABORT, 'boom'); END`
    );
    expect(
      code(() =>
        applyGoldRates(
          f.db,
          's1',
          { rates: [{ karat: 21, ratePerGram: 310_000 }] },
          { userId: 'u' },
          { now: T0 + 1, newId: ids }
        )
      )
    ).toContain('boom');
    expect(f.price('a')).toBe(pa);
    expect(f.rate(21).r).toBe(300_000);
    expect(f.raw.prepare(`SELECT count(*) AS n FROM gold_rates`).get()).toEqual({ n: 1 });
    // the guard flag is cleared even though the section threw
    expect(f.raw.prepare(`SELECT value FROM do_flags WHERE name='gold_reprice'`).get()).toEqual({
      value: 0,
    });
  });

  it('outside the repricer a direct price write on a gold row is refused (SQLite guard)', () => {
    const f = fx();
    f.product('p1');
    applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 300_000 }] },
      { userId: 'u' },
      { now: T0, newId: ids }
    );
    expect(
      code(() => f.raw.prepare(`UPDATE products SET price = 1 WHERE id='p1'`).run())
    ).toContain('GOLD_PRICE_MANAGED');
  });

  it('rejects hostile input: 0 or 4 rates, duplicate karat, out-of-range, non-integer, missing store', () => {
    const f = fx();
    const w = (rates: any, store = 's1') =>
      code(() => applyGoldRates(f.db, store, { rates }, { userId: 'u' }, { now: T0, newId: ids }));
    expect(w([])).toBe('GOLD_RATE_INVALID');
    expect(w([{ karat: 21, ratePerGram: 1 }])).toBe('GOLD_RATE_INVALID');
    expect(w([{ karat: 21, ratePerGram: 300_000.5 }])).toBe('GOLD_RATE_INVALID');
    expect(
      w([
        { karat: 21, ratePerGram: 300_000 },
        { karat: 21, ratePerGram: 300_000 },
      ])
    ).toBe('GOLD_RATE_INVALID');
    expect(w([{ karat: 22, ratePerGram: 300_000 }])).toBe('GOLD_RATE_INVALID');
    expect(w([{ karat: 21, ratePerGram: 300_000 }], '')).toBe('STORE_REQUIRED');
  });

  it("another store's products are never repriced", () => {
    const f = fx();
    f.product('mine');
    f.product('theirs', { store: 's2', price: 999 });
    applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 300_000 }] },
      { userId: 'u' },
      { now: T0, newId: ids }
    );
    expect(f.price('theirs')).toBe(999);
  });

  it('after a rate write the checkout gate prices at the NEW rate (gate and writer agree)', () => {
    const f = fx();
    f.product('p1');
    applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 300_000 }] },
      { userId: 'u' },
      { now: T0, newId: ids }
    );
    const r = assertGoldLinesPriceable(
      f.db,
      's1',
      [
        {
          key: 'p1',
          productId: 'p1',
          variantId: null,
          materialisedUnitPrice: expectPrice(300_000),
          quotedUnitPrice: null,
        },
      ],
      { requireQuote: false, now: T0 + 60_000 }
    );
    expect(r.unitPrices.get('p1')).toBe(expectPrice(300_000));
  });

  it('a pending feed rate: reject leaves everything; confirm makes it current and reprices; a decided rate cannot be decided twice', () => {
    const f = fx();
    f.product('p1');
    applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 300_000 }] },
      { userId: 'u' },
      { now: T0, newId: ids }
    );
    const a = applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 500_000 }] },
      { feed: {} },
      { now: T0 + 1, newId: ids }
    ).pending[0];
    const b = applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 520_000 }] },
      { feed: {} },
      { now: T0 + 2, newId: ids }
    ).pending[0];
    expect(decidePendingGoldRate(f.db, 's1', b.id, 'reject', { userId: 'o' })).toEqual({
      status: 'rejected',
      repriced: 0,
    });
    expect(f.rate(21).r).toBe(300_000);
    expect(code(() => decidePendingGoldRate(f.db, 's1', a.id, 'confirm', { userId: 'o' }))).toBe(
      'RATE_NOT_PENDING'
    ); // superseded
    const c = applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 530_000 }] },
      { feed: {} },
      { now: T0 + 3, newId: ids }
    ).pending[0];
    expect(
      decidePendingGoldRate(f.db, 's1', c.id, 'confirm', { userId: 'o' }, { now: T0 + 4 }).repriced
    ).toBe(1);
    expect(f.rate(21).r).toBe(530_000);
    expect(f.price('p1')).toBe(expectPrice(530_000));
    expect(code(() => decidePendingGoldRate(f.db, 's1', c.id, 'reject', { userId: 'o' }))).toBe(
      'RATE_NOT_PENDING'
    );
    expect(code(() => decidePendingGoldRate(f.db, 's2', c.id, 'confirm', { userId: 'o' }))).toBe(
      'NOT_FOUND'
    ); // other store
  });

  it('a changed rounding step reprices every gold row in the same section; an unchanged one does not; bad input is refused', () => {
    const f = fx();
    f.product('p1');
    applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 300_123 }] },
      { userId: 'u' },
      { now: T0, newId: ids }
    );
    const s = {
      enabled: true,
      feedEnabled: false,
      feedPremiumBps: 0,
      maxAgeMinutes: 1560,
      jumpConfirmBps: 500,
      roundingStep: 100 as const,
      showBreakdown: false,
    };
    expect(updateGoldSettings(f.db, 's1', s, { userId: 'o' }).repriced).toBe(0);
    expect(
      updateGoldSettings(f.db, 's1', { ...s, roundingStep: 1000 }, { userId: 'o' }).repriced
    ).toBe(1);
    expect(f.price('p1')).toBe(computeGoldUnitPrice(SPEC, 300_123, 1000).unitPrice);
    expect(
      code(() =>
        updateGoldSettings(f.db, 's1', { ...s, roundingStep: 7 as never }, { userId: 'o' })
      )
    ).toBe('GOLD_SETTINGS_INVALID');
  });

  it('repriceGoldProduct reprices only that product after a spec edit', () => {
    const f = fx();
    f.product('a');
    f.product('b');
    applyGoldRates(
      f.db,
      's1',
      { rates: [{ karat: 21, ratePerGram: 300_000 }] },
      { userId: 'u' },
      { now: T0, newId: ids }
    );
    f.raw.exec("INSERT OR REPLACE INTO do_flags (name, value) VALUES ('gold_reprice', 0)");
    f.raw.exec("UPDATE products SET gold_weight_mg = 20000 WHERE id IN ('a', 'b')");
    const pb = f.price('b');
    expect(repriceGoldProduct(f.db, 's1', 'a')).toBe(1);
    expect(f.price('a')).toBe(
      computeGoldUnitPrice({ ...SPEC, weightMg: 20_000 }, 300_000, 100).unitPrice
    );
    expect(f.price('b')).toBe(pb);
  });
});
