/** Ruling B2-9: the instalment estimate is integer arithmetic over the merchant's own settings. */
import { describe, it, expect } from 'vitest';
import { instalmentMonthly, instalmentsSchema, resolveInstalment } from '@ebda/shared';
import { instalmentText } from '../../apps/web/src/lib/instalment';

describe('instalmentMonthly = ceil(price x (1 + markup/100) / months)', () => {
  it.each([
    [1_290_000 * 12, 12, 0, 1_290_000],
    [100_000, 3, 0, 33_334], // ceil, never under-quotes
    [100_000, 12, 10, 9_167], // 110000 / 12 = 9166.67
    [100_000, 12, 2.5, 8_542], // 102500 / 12 = 8541.67: 2.5 % is exact in basis points
    [999_999, 60, 100, 33_334],
    [1, 3, 0, 1],
  ])('price %i, %i months, %f %% -> %i', (price, months, markupPct, want) => {
    expect(instalmentMonthly(price, { months, markupPct })).toBe(want);
  });
  it('is an integer and never below price / months', () => {
    for (const price of [1, 7, 999, 123_457, 4_500_000])
      for (const months of [3, 6, 12, 24, 60])
        for (const markupPct of [0, 0.5, 5, 33.3, 100]) {
          const m = instalmentMonthly(price, { months, markupPct });
          expect(Number.isInteger(m)).toBe(true);
          expect(m).toBeGreaterThanOrEqual(price / months);
        }
  });
});

describe('instalmentsSchema (the Zod edge)', () => {
  const ok = { enabled: true, months: 12, markupPct: 0 };
  it('accepts the bounds', () => {
    expect(instalmentsSchema.safeParse({ ...ok, months: 3, markupPct: 100 }).success).toBe(true);
    expect(instalmentsSchema.safeParse({ ...ok, months: 60 }).success).toBe(true);
  });
  it.each([
    { ...ok, months: 2 },
    { ...ok, months: 61 },
    { ...ok, markupPct: -0.1 },
    { ...ok, markupPct: 100.1 },
    { ...ok, extra: 1 },
    { ...ok, logo: 'https://x/y.png' },
  ])('rejects %j', bad => expect(instalmentsSchema.safeParse(bad).success).toBe(false));
});

describe('resolveInstalment: when the line exists at all', () => {
  const on = { enabled: true, months: 12, markupPct: 0 };
  it('absent, null, disabled, invalid -> nothing', () => {
    for (const raw of [undefined, null, { ...on, enabled: false }, { ...on, months: 1 }, 'x', 7])
      expect(resolveInstalment(raw, 1_290_000, true)).toBeNull();
  });
  it('not buyable or no positive price -> nothing', () => {
    expect(resolveInstalment(on, 1_290_000, false)).toBeNull();
    expect(resolveInstalment(on, 0, true)).toBeNull();
    expect(resolveInstalment(on, -5, true)).toBeNull();
  });
  it('minPrice gates it (default 0)', () => {
    expect(resolveInstalment({ ...on, minPrice: 500_000 }, 499_999, true)).toBeNull();
    expect(resolveInstalment({ ...on, minPrice: 500_000 }, 500_000, true)).not.toBeNull();
    expect(resolveInstalment(on, 1, true)).not.toBeNull();
  });
  it('carries the typed provider NAME only', () => {
    const r = resolveInstalment({ ...on, providerEn: 'Acme', providerAr: '' }, 12_000, true)!;
    expect(r.providerEn).toBe('Acme');
    expect(r.providerAr).toBeUndefined();
  });
});

describe('instalmentText', () => {
  const money = (n: number) => `EGP ${n.toLocaleString('en')}`;
  const moneyAr = (n: number) => `${n.toLocaleString('en')} ج.م`;
  it('English: estimate wording, no provider unless typed', () => {
    expect(instalmentText('en', { monthly: 1290, months: 12 }, money)).toBe(
      'From EGP 1,290 / month for 12 months · estimate'
    );
    expect(instalmentText('en', { monthly: 1290, months: 12, providerEn: 'Acme' }, money)).toBe(
      'Instalments via Acme from EGP 1,290 / month for 12 months · estimate'
    );
    expect(instalmentText('en', { monthly: 5, months: 3 }, money)).toContain('for 3 months');
  });
  it('Arabic: "تقريبي", the month count through the plural helper', () => {
    expect(instalmentText('ar', { monthly: 1290, months: 12 }, moneyAr)).toBe(
      'تقسيط يبدأ من 1,290 ج.م / شهر على 12 شهرًا · تقريبي'
    );
    expect(instalmentText('ar', { monthly: 1, months: 6 }, moneyAr)).toContain('على 6 أشهر');
    expect(instalmentText('ar', { monthly: 1, months: 6, providerAr: 'اسم' }, moneyAr)).toContain(
      'تقسيط عبر اسم يبدأ من'
    );
  });
  it('never claims an approval, a rate name or a logo', () => {
    for (const lang of ['ar', 'en'] as const) {
      const text = instalmentText(lang, { monthly: 1, months: 12 }, money);
      expect(text).not.toMatch(/معتمد|approved|guaranteed|مضمون|<img|logo/i);
    }
  });
});
