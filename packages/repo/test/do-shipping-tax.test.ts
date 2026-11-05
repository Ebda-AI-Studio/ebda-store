// DO ports of shipping, order tax and the COD fee (node:sqlite on the real StoreDO schema), diffed against the
// Postgres-side pure functions over generated inputs.
import { describe, expect, it, vi } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { MoneyError } from '../src/do/sync-sql';
import {
  calculateShipping,
  foldPlaceName as foldPort,
  resolveShippingFee as resolvePort,
  zoneForAddress as zonePort,
} from '../src/do/shipping';
import {
  computeOrderAmounts as amountsPort,
  computeOrderTaxFields,
  frozenTaxInvoiceFields,
  mulDivRound as mulDivPort,
  resolveActiveTaxRate,
} from '../src/do/tax';
import { codFeeForCheckout, codFeeForOrder as codPort, loadCodFeeConfig } from '../src/do/cod-fee';
import { computeOrderAmounts, codFeeForOrder } from '../../shared/src/order-tax';
import { mulDivRound } from '../../shared/src/region';
import { foldPlaceName, zoneForAddress } from '../../shared/src/commerce/delivery-window';
import { resolveShippingFee } from '../../../apps/api/src/services/shipping.service';

// resolveShippingFee (apps/api) is pure but its module imports the Prisma client; the generated client and the
// shared dist are not built in this package's test run, so the two heavy imports are replaced by the real pure sources.
vi.mock('@ebda/database', () => ({ prisma: {}, Prisma: {} }));
vi.mock('../../../apps/api/src/middleware/error-handler', () => ({
  AppError: class extends Error {},
}));
vi.mock('@ebda/shared', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...(await import('../../shared/src/commerce/delivery-window')),
}));

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
  const zone = (
    id: string,
    o: Partial<{
      store: string;
      areas: string[];
      areasAr: string[];
      fee: number;
      thr: number | null;
      pos: number;
      active: number;
      days: [number | null, number | null, number | null];
    }> = {}
  ) =>
    raw
      .prepare(
        `INSERT INTO shipping_zones (id, store_id, name, name_ar, areas, areas_ar, delivery_fee, free_shipping_threshold, estimated_days, estimated_days_min, estimated_days_max, position, is_active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        o.store ?? 's1',
        `Zone ${id}`,
        `منطقة ${id}`,
        JSON.stringify(o.areas ?? []),
        JSON.stringify(o.areasAr ?? []),
        o.fee ?? 5000,
        o.thr === undefined ? null : o.thr,
        ...(o.days ?? [null, null, null]),
        o.pos ?? 0,
        o.active ?? 1
      );
  const rate = (
    id: string,
    gov: string,
    area: string,
    fee: number,
    o: Partial<{ store: string; thr: number | null; active: number; pos: number }> = {}
  ) =>
    raw
      .prepare(
        `INSERT INTO shipping_area_rates (id, store_id, governorate, governorate_ar, area, area_ar, delivery_fee, free_shipping_threshold, is_active, position) VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        o.store ?? 's1',
        gov,
        gov,
        area,
        area,
        fee,
        o.thr === undefined ? null : o.thr,
        o.active ?? 1,
        o.pos ?? 0
      );
  const config = (o: { enabled?: number; incl?: number; store?: string } = {}) =>
    raw
      .prepare(
        `INSERT INTO store_config (store_id, tax_enabled, tax_included_in_price) VALUES (?,?,?)`
      )
      .run(o.store ?? 's1', o.enabled ?? 1, o.incl ?? 0);
  const taxRate = (id: string, hundredths: number, active = 1, store = 's1') =>
    raw
      .prepare(`INSERT INTO tax_rates (id, store_id, name, rate, is_active) VALUES (?,?,?,?,?)`)
      .run(id, store, `r${id}`, hundredths, active);
  const profile = (
    status: string,
    trn: string | null = '123-456-789',
    legal: string | null = 'Acme LLC',
    store = 's1'
  ) =>
    raw
      .prepare(
        `INSERT INTO store_tax_profiles (id, store_id, status, tax_registration_number, legal_name) VALUES (?,?,?,?,?)`
      )
      .run(`p-${store}`, store, status, trn, legal);
  const cod = (fixed: number, settings: string, enabled = 1, store = 's1') =>
    raw
      .prepare(
        `INSERT INTO payment_configs (id, store_id, provider, is_enabled, fixed_fee, settings) VALUES (?,?,?,?,?,?)`
      )
      .run(`c-${store}`, store, 'cod', enabled, fixed, settings);
  return { raw, db, zone, rate, config, taxRate, profile, cod };
}

describe('shipping: calculateShipping', () => {
  it('area rate beats a zone that also names the area; governorate disambiguates same-named areas', () => {
    const { db, zone, rate } = fx();
    zone('z1', { areas: ['Maadi'], fee: 9999 });
    rate('r1', 'Cairo', 'Maadi', 4000);
    rate('r2', 'Giza', 'Maadi', 6000);
    expect(calculateShipping(db, 's1', 'maadi', 100, 'GIZA')).toMatchObject({
      matched: true,
      shippingCost: 6000,
      zone: null,
      storeHasAreaRates: true,
    });
    expect(calculateShipping(db, 's1', 'MAADI', 100, 'cairo').shippingCost).toBe(4000);
    // no governorate: the first rate by position, id
    expect(calculateShipping(db, 's1', 'Maadi', 100).shippingCost).toBe(4000);
    // a governorate that names neither rate falls through to the zone
    const z = calculateShipping(db, 's1', 'Maadi', 100, 'Alexandria');
    expect(z).toMatchObject({ matched: true, shippingCost: 9999, zone: { id: 'z1' } });
  });

  it('free-shipping threshold boundary: total == threshold is free, threshold-1 is not (rate, zone, fallback)', () => {
    const { db, zone, rate } = fx();
    rate('r1', 'Cairo', 'Nasr City', 3000, { thr: 10000 });
    zone('z1', { areas: ['Tanta'], fee: 7000, thr: 20000 });
    expect(calculateShipping(db, 's1', 'Nasr City', 9999, 'Cairo')).toMatchObject({
      shippingCost: 3000,
      freeShipping: false,
    });
    expect(calculateShipping(db, 's1', 'Nasr City', 10000, 'Cairo')).toMatchObject({
      shippingCost: 0,
      freeShipping: true,
    });
    expect(calculateShipping(db, 's1', 'Tanta', 19999).shippingCost).toBe(7000);
    expect(calculateShipping(db, 's1', 'Tanta', 20000)).toMatchObject({
      shippingCost: 0,
      freeShipping: true,
    });
  });

  it('threshold 0 means always free; null means never', () => {
    const { db, rate } = fx();
    rate('r1', 'Cairo', 'A', 3000, { thr: 0 });
    rate('r2', 'Cairo', 'B', 3000, { thr: null });
    expect(calculateShipping(db, 's1', 'A', 0, 'Cairo').freeShipping).toBe(true);
    expect(calculateShipping(db, 's1', 'B', 2_000_000_000, 'Cairo').freeShipping).toBe(false);
  });

  it('zone match is by WHOLE folded name (never a substring), area first then governorate, Arabic folded', () => {
    const { db, zone } = fx();
    zone('z1', { areas: ['Tor'], areasAr: ['القاهره'], fee: 1000, pos: 1 });
    zone('z2', { areas: ['Giza'], fee: 2000, pos: 2, days: [2, 1, 3] });
    expect(calculateShipping(db, 's1', 'Victoria', 0, 'Giza')).toMatchObject({
      zone: { id: 'z2' },
      shippingCost: 2000,
      estimatedDays: 2,
      estimatedDaysMin: 1,
      estimatedDaysMax: 3,
    });
    // the area names no zone but the governorate does (Arabic ة/ه fold)
    expect(calculateShipping(db, 's1', 'zzz', 0, 'القاهرة').zone?.id).toBe('z1');
    // "New Cairo" is not "Cairo"; a store with zones and NO area rates then falls back to the FIRST zone (legacy)
    const fb = calculateShipping(db, 's1', 'Nowhere', 0, 'Nowhere');
    expect(fb).toMatchObject({ matched: true, storeHasAreaRates: false, zone: { id: 'z1' } });
  });

  it('with area rates configured and nothing matching there is NO fallback to the first zone', () => {
    const { db, zone, rate } = fx();
    zone('z1', { areas: ['Tanta'] });
    rate('r1', 'Cairo', 'Maadi', 4000);
    expect(calculateShipping(db, 's1', 'Nowhere', 0, 'Nowhere')).toMatchObject({
      matched: false,
      storeHasAreaRates: true,
      shippingCost: 0,
      zone: null,
    });
  });

  it('inactive rows are ignored and a store with nothing configured matches nothing', () => {
    const { db, zone, rate } = fx();
    expect(calculateShipping(db, 's1', 'x', 0)).toMatchObject({
      matched: false,
      storeHasAreaRates: false,
    });
    zone('z1', { areas: ['x'], active: 0 });
    rate('r1', 'Cairo', 'x', 100, { active: 0 });
    expect(calculateShipping(db, 's1', 'x', 0, 'Cairo')).toMatchObject({
      matched: false,
      storeHasAreaRates: false,
    });
  });

  it('is scoped to the store: another store’s rates and zones never leak in', () => {
    const { db, zone, rate } = fx();
    rate('r1', 'Cairo', 'Maadi', 100, { store: 's2' });
    zone('z1', { store: 's2', areas: ['Maadi'] });
    expect(calculateShipping(db, 's1', 'Maadi', 0, 'Cairo').matched).toBe(false);
    expect(calculateShipping(db, 's2', 'Maadi', 0, 'Cairo').shippingCost).toBe(100);
  });

  it('refuses hostile input and corrupt stored config', () => {
    const { db, raw, zone } = fx();
    for (const bad of [-1, 1.5, NaN, Infinity, 3_000_000_000, '5' as never])
      expect(err(() => calculateShipping(db, 's1', 'a', bad as number)).code).toBe('INVALID_INPUT');
    expect(err(() => calculateShipping(db, 's1', 'a'.repeat(201), 0)).code).toBe('INVALID_INPUT');
    expect(err(() => calculateShipping(db, 's1', {} as never, 0)).code).toBe('INVALID_INPUT');
    expect(err(() => calculateShipping(db, 's1', 'a', 0, 5 as never)).code).toBe('INVALID_INPUT');
    expect(err(() => calculateShipping(db, '', 'a', 0)).code).toBe('INVALID_INPUT');
    zone('z1');
    raw.exec(`UPDATE shipping_zones SET areas = '{"a":1}' WHERE id = 'z1'`);
    expect(err(() => calculateShipping(db, 's1', 'a', 0)).code).toBe('SHIPPING_CONFIG_CORRUPT');
    raw.exec(`UPDATE shipping_zones SET areas = '[1]' WHERE id = 'z1'`);
    expect(err(() => calculateShipping(db, 's1', 'a', 0)).code).toBe('SHIPPING_CONFIG_CORRUPT');
  });

  it('SQL metacharacters in area/governorate are bound parameters, not SQL', () => {
    const { db, raw, rate } = fx();
    rate('r1', 'Cairo', 'Maadi', 100);
    const q = calculateShipping(db, 's1', `x'; DROP TABLE shipping_zones; --`, 0, `' OR '1'='1`);
    expect(q.matched).toBe(false);
    expect(raw.prepare(`SELECT count(*) n FROM shipping_zones`).get()).toBeTruthy();
  });
});

describe('shipping: diff against the Postgres-side pure functions', () => {
  it('foldPlaceName and zoneForAddress agree over generated names', () => {
    const r = rng(1);
    const alphabet = ['a', 'B', ' ', 'c', 'ا', 'أ', 'إ', 'ى', 'ي', 'ة', 'ه', 'ً', 'ـ', 'م', ' '];
    const word = () =>
      Array.from(
        { length: Math.floor(r() * 7) },
        () => alphabet[Math.floor(r() * alphabet.length)]
      ).join('');
    for (let i = 0; i < 400; i++) {
      const w = word();
      expect(foldPort(w)).toBe(foldPlaceName(w));
      const zones = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, k) => ({
        id: `z${k}`,
        name: 'n',
        nameAr: null,
        areas: [word(), word()],
        areasAr: [word()],
        deliveryFee: 1,
        freeShippingThreshold: null,
        estimatedDays: null,
        estimatedDaysMin: null,
        estimatedDaysMax: null,
      }));
      const addr = { area: r() < 0.5 ? word() : zones[0]!.areas[0]!, governorate: word() };
      expect(zonePort(addr, zones)?.id).toBe(zoneForAddress(addr, zones)?.id);
    }
  });

  it('resolveShippingFee agrees with the Postgres resolver over generated rates, zones and totals', () => {
    const r = rng(2);
    const names = ['Maadi', 'maadi', 'Nasr', 'Giza', 'Cairo', '', 'Tanta', 'القاهرة'];
    const pick = () => names[Math.floor(r() * names.length)]!;
    const thr = () => (r() < 0.3 ? null : Math.floor(r() * 6) * 1000);
    for (let i = 0; i < 600; i++) {
      const rates = Array.from({ length: Math.floor(r() * 4) }, () => ({
        area: pick(),
        governorate: pick(),
        deliveryFee: Math.floor(r() * 9000),
        freeShippingThreshold: thr(),
        isActive: r() < 0.8,
      }));
      const zones = Array.from({ length: Math.floor(r() * 3) }, (_, k) => ({
        id: `z${k}`,
        name: 'n',
        nameAr: null,
        areas: [pick()],
        areasAr: [pick()],
        deliveryFee: Math.floor(r() * 9000),
        freeShippingThreshold: thr(),
        estimatedDays: null,
        estimatedDaysMin: null,
        estimatedDaysMax: null,
      }));
      const input = {
        area: pick(),
        governorate: r() < 0.3 ? '' : pick(),
        orderTotal: Math.floor(r() * 6) * 1000,
      };
      const a = resolvePort(rates, zones, input);
      const b = resolveShippingFee(rates, zones, input);
      expect({ ...a, matchedZone: a.matchedZone?.id ?? null }).toEqual({
        ...b,
        matchedZone: (b.matchedZone as { id: string } | null)?.id ?? null,
      });
    }
  });
});

describe('tax: computeOrderAmounts, resolver and VAT-profile gate', () => {
  it('exclusive: tax added on top of goods + shipping + COD fee, discount first, half up', () => {
    // base = (10000-1000) + 2500 + 1000 = 12500; 14% = 1750
    expect(
      amountsPort({
        subtotal: 10000,
        discount: 1000,
        shipping: 2500,
        codFee: 1000,
        ratePercent: 14,
      })
    ).toEqual({ taxableAmount: 12500, tax: 1750, total: 14250 });
    // half piastre rounds UP: 5 * 10% = 0.5 -> 1 ; 4 -> 0.4 -> 0
    expect(amountsPort({ subtotal: 5, discount: 0, shipping: 0, ratePercent: 10 }).tax).toBe(1);
    expect(amountsPort({ subtotal: 4, discount: 0, shipping: 0, ratePercent: 10 }).tax).toBe(0);
  });

  it('inclusive: VAT extracted (base * bps / (10000 + bps)), total is the gross, taxable is net', () => {
    // gross 11400 at 14% -> tax = 11400*1400/11400 = 1400 ; net 10000
    expect(
      amountsPort({
        subtotal: 11400,
        discount: 0,
        shipping: 0,
        ratePercent: 14,
        includedInPrice: true,
      })
    ).toEqual({ taxableAmount: 10000, tax: 1400, total: 11400 });
    // shipping + COD fee are gross too
    expect(
      amountsPort({
        subtotal: 10000,
        discount: 0,
        shipping: 1000,
        codFee: 400,
        ratePercent: 14,
        includedInPrice: true,
      })
    ).toEqual({ taxableAmount: 10000, tax: 1400, total: 11400 });
    // inclusive half-up: 1 piastre at 14% -> 1400/11400*1 = 0.12 -> 0 ; 4 -> .49 -> 0 ; 5 -> .61 -> 1
    expect(
      amountsPort({ subtotal: 4, discount: 0, shipping: 0, ratePercent: 14, includedInPrice: true })
        .tax
    ).toBe(0);
    expect(
      amountsPort({ subtotal: 5, discount: 0, shipping: 0, ratePercent: 14, includedInPrice: true })
        .tax
    ).toBe(1);
  });

  it('discount larger than subtotal never makes a negative base; rate 0 means no tax', () => {
    expect(amountsPort({ subtotal: 100, discount: 500, shipping: 300, ratePercent: 14 })).toEqual({
      taxableAmount: 300,
      tax: 42,
      total: 342,
    });
    expect(amountsPort({ subtotal: 100, discount: 0, shipping: 0, ratePercent: 0 }).tax).toBe(0);
  });

  it('mulDivRound is half up, symmetric for negatives, and refuses non-integers / overflow', () => {
    expect(mulDivPort(1, 1, 2)).toBe(1);
    expect(mulDivPort(-1, 1, 2)).toBe(-1);
    expect(err(() => mulDivPort(1.5, 1, 2)).code).toBe('AMOUNT_INVALID');
    expect(err(() => mulDivPort(1, 1, 0)).code).toBe('AMOUNT_INVALID');
    expect(err(() => mulDivPort(2 ** 52, 4, 1)).code).toBe('AMOUNT_OVERFLOW');
  });

  it('refuses hostile amounts and rates', () => {
    const ok = { subtotal: 1, discount: 0, shipping: 0, ratePercent: 14 };
    for (const o of [
      { subtotal: 1.5 },
      { subtotal: NaN },
      { discount: Infinity },
      { shipping: '1' },
      { codFee: 3_000_000_000 },
      { ratePercent: -1 },
      { ratePercent: 1000 },
      { ratePercent: NaN },
    ])
      expect(err(() => amountsPort({ ...ok, ...o } as never)).code).toBe('INVALID_INPUT');
  });

  it('the VAT gate: only a VERIFIED profile with a TRN and legal name makes a tax invoice; every other state is a receipt with 0 VAT', () => {
    for (const [status, trn, legal, kind] of [
      ['verified', '111', 'Acme', 'tax_invoice'],
      ['pending', '111', 'Acme', 'receipt'],
      ['none', null, null, 'receipt'],
      ['rejected', '111', 'Acme', 'receipt'],
      ['revoked', '111', 'Acme', 'receipt'],
      ['verified', null, 'Acme', 'receipt'],
      ['verified', '111', null, 'receipt'],
      ['verified', '', 'Acme', 'receipt'],
    ] as const) {
      const f = fx();
      f.config({ enabled: 1 });
      f.taxRate('t1', 1400);
      f.profile(status, trn, legal);
      const t = computeOrderTaxFields(f.db, 's1', { subtotal: 10000, discount: 0, shipping: 0 });
      expect(t.documentKind).toBe(kind);
      if (kind === 'tax_invoice')
        expect(t).toMatchObject({
          tax: 1400,
          total: 11400,
          taxRateBps: 1400,
          sellerTaxRegistrationNumber: '111',
          sellerTaxLegalName: 'Acme',
        });
      else
        expect(t).toMatchObject({
          tax: 0,
          total: 10000,
          taxRateBps: null,
          sellerTaxRegistrationNumber: null,
          sellerTaxLegalName: null,
        });
    }
  });

  it('no profile row at all, tax switched off, or no active rate -> 0 VAT; inclusive flag still reported', () => {
    const a = fx();
    a.config({ enabled: 1, incl: 1 });
    a.taxRate('t1', 1400);
    expect(resolveActiveTaxRate(a.db, 's1')).toEqual({
      ratePercent: 0,
      includedInPrice: true,
      seller: null,
    });
    const b = fx();
    b.config({ enabled: 0 });
    b.taxRate('t1', 1400);
    b.profile('verified');
    expect(resolveActiveTaxRate(b.db, 's1').ratePercent).toBe(0);
    const c = fx();
    c.config();
    c.taxRate('t1', 1400, 0);
    c.profile('verified');
    expect(resolveActiveTaxRate(c.db, 's1').seller).toBeNull();
    const d = fx(); // no store_config row at all
    d.profile('verified');
    d.taxRate('t1', 1400);
    expect(resolveActiveTaxRate(d.db, 's1')).toEqual({
      ratePercent: 0,
      includedInPrice: false,
      seller: null,
    });
  });

  it('every ACTIVE rate is summed (5% + 2% = 7%), inactive ones and other stores are not', () => {
    const f = fx();
    f.config();
    f.profile('verified');
    f.taxRate('t1', 500);
    f.taxRate('t2', 200);
    f.taxRate('t3', 900, 0);
    f.taxRate('t4', 1400, 1, 's2');
    const a = resolveActiveTaxRate(f.db, 's1');
    expect(a.ratePercent).toBe(7);
    expect(frozenTaxInvoiceFields(a).taxRateBps).toBe(700);
    // 0.1% + 0.2% sums exactly (hundredths), never 0.30000000000000004
    const g = fx();
    g.config();
    g.profile('verified');
    g.taxRate('t1', 10);
    g.taxRate('t2', 20);
    expect(resolveActiveTaxRate(g.db, 's1').ratePercent).toBe(0.3);
    expect(frozenTaxInvoiceFields(resolveActiveTaxRate(g.db, 's1')).taxRateBps).toBe(30);
  });

  it('store_config of another store does not enable tax here; a corrupt rate fails closed', () => {
    const f = fx();
    f.config({ store: 's2', enabled: 1 });
    f.profile('verified');
    f.taxRate('t1', 1400);
    expect(resolveActiveTaxRate(f.db, 's1').ratePercent).toBe(0);
    f.raw.exec(`UPDATE tax_rates SET rate = -5`);
    expect(err(() => resolveActiveTaxRate(f.db, 's1')).code).toBe('TAX_CONFIG_CORRUPT');
  });

  it('COD fee is in the VAT base and the total (exclusive and inclusive)', () => {
    const f = fx();
    f.config();
    f.taxRate('t1', 1400);
    f.profile('verified');
    f.cod(1000, '{"percentBps":200}');
    const amounts = { subtotal: 10000, discount: 0, shipping: 2000 };
    const codFee = codFeeForCheckout(f.db, 's1', 'cod', amounts);
    expect(codFee).toBe(1000 + 240); // 2% of 12000
    const t = computeOrderTaxFields(f.db, 's1', { ...amounts, codFee });
    expect(t).toMatchObject({ taxableAmount: 13240, tax: 1854, total: 15094 }); // 13240*14% = 1853.6
  });

  it('diff: computeOrderAmounts agrees with the shared implementation over generated inputs', () => {
    const r = rng(3);
    for (let i = 0; i < 2000; i++) {
      const input = {
        subtotal: Math.floor(r() * 5_000_000),
        discount: Math.floor(r() * 5_500_000),
        shipping: Math.floor(r() * 50_000),
        codFee: r() < 0.5 ? undefined : Math.floor(r() * 20_000),
        ratePercent: Math.floor(r() * 3000) / 100,
        includedInPrice: r() < 0.5,
      };
      expect(amountsPort(input)).toEqual(computeOrderAmounts(input));
    }
    for (let i = 0; i < 2000; i++) {
      const a = Math.floor(r() * 1e7) - 5e6;
      const n = Math.floor(r() * 3e4) - 1e4;
      const d = 1 + Math.floor(r() * 3e4);
      expect(mulDivPort(a, n, d)).toBe(mulDivRound(a, n, d));
    }
  });
});

describe('cod fee', () => {
  it('fixed + percent of (goods after discount + shipping), half up; no fee-on-fee or fee-on-VAT', () => {
    expect(
      codPort(
        { subtotal: 10000, discount: 2000, shipping: 1000 },
        { fixedFee: 500, percentBps: 250 }
      )
    ).toBe(500 + 225); // 2.5% of 9000
    expect(
      codPort({ subtotal: 10, discount: 0, shipping: 0 }, { fixedFee: 0, percentBps: 500 })
    ).toBe(1); // 0.5 -> 1
    expect(
      codPort({ subtotal: 9, discount: 0, shipping: 0 }, { fixedFee: 0, percentBps: 500 })
    ).toBe(0);
  });

  it('COD off (no config / null) or a non-COD method is fee 0; discount over subtotal never goes negative', () => {
    const f = fx();
    const a = { subtotal: 10000, discount: 0, shipping: 0 };
    expect(codPort(a, null)).toBe(0);
    expect(codFeeForCheckout(f.db, 's1', 'cod', a)).toBe(0); // no payment_configs row
    f.cod(700, '{}');
    expect(codFeeForCheckout(f.db, 's1', 'cod', a)).toBe(700);
    expect(codFeeForCheckout(f.db, 's1', 'card', a)).toBe(0);
    expect(codFeeForCheckout(f.db, 's2', 'cod', a)).toBe(0); // other store
    expect(
      codPort({ subtotal: 100, discount: 9999, shipping: 0 }, { fixedFee: 0, percentBps: 500 })
    ).toBe(0);
  });

  it('a disabled COD config is COD off; non-object settings read as 0%; bad config numbers clamp like Postgres', () => {
    const f = fx();
    f.cod(700, '{"percentBps":-5}', 0);
    expect(loadCodFeeConfig(f.db, 's1')).toBeNull();
    f.raw.exec(`UPDATE payment_configs SET is_enabled = 1`);
    expect(loadCodFeeConfig(f.db, 's1')).toEqual({ fixedFee: 700, percentBps: 0 });
    // the schema CHECKs json_valid, so malformed JSON cannot be stored; non-object JSON reads as no percentage part
    for (const settings of ['null', '[]', '{"percentBps":"x"}']) {
      f.raw.exec(`UPDATE payment_configs SET settings = '${settings}'`);
      expect(loadCodFeeConfig(f.db, 's1')).toEqual({ fixedFee: 700, percentBps: 0 });
    }
    f.raw.exec(`UPDATE payment_configs SET settings = '{"percentBps":249.6}'`);
    expect(loadCodFeeConfig(f.db, 's1')?.percentBps).toBe(250);
  });

  it('refuses hostile amounts', () => {
    for (const bad of [1.5, NaN, '1', 3e9])
      expect(
        err(() => codPort({ subtotal: bad as number, discount: 0, shipping: 0 }, null)).code
      ).toBe('INVALID_INPUT');
  });

  it('diff: codFeeForOrder agrees with the shared implementation over generated inputs', () => {
    const r = rng(4);
    for (let i = 0; i < 2000; i++) {
      const amounts = {
        subtotal: Math.floor(r() * 5_000_000),
        discount: Math.floor(r() * 5_500_000),
        shipping: Math.floor(r() * 50_000),
      };
      const cfg =
        r() < 0.1 ? null : { fixedFee: Math.floor(r() * 5000), percentBps: Math.floor(r() * 1000) };
      expect(codPort(amounts, cfg)).toBe(codFeeForOrder(amounts, cfg));
    }
  });
});
