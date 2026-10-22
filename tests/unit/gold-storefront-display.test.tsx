// @vitest-environment jsdom
/**
 * Storefront side of gold-rate pricing (B5 Task 14): the rate line under a gold price, the stale state (by the
 * browser clock, display only), the moved-price notice, and the cart line mapping. Nothing here computes a price.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';

const ctx = vi.hoisted(() => ({ language: 'ar' as 'ar' | 'en' }));
vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLanguage: () => ({
    language: ctx.language,
    isRtl: ctx.language === 'ar',
    t: (en: string, ar: string) => (ctx.language === 'ar' ? ar : en),
  }),
}));
vi.mock('../../apps/web/src/hooks/useLocalePrice', () => ({
  useLocalePrice: () => (n: number) => `EGP ${(n / 100).toFixed(2)}`,
}));
vi.mock('../../apps/web/src/hooks/useNumerals', () => ({
  useNumerals: () => ({ localize: (n: number | string) => String(n), numerals: 'latn' }),
}));

import {
  GoldRateLine,
  useGoldRateStale,
} from '../../apps/web/src/components/commerce/GoldRateLine';
import { PriceChangedNotice } from '../../apps/web/src/components/commerce/PriceChangedNotice';
import {
  goldRateIsStale,
  goldRateTime,
  priceChangedLines,
} from '../../apps/web/src/lib/gold-display';
import { mapServerItem } from '../../apps/web/src/contexts/cart-lines';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const gold = (over: Record<string, unknown> = {}) => ({
  karat: 21 as const,
  weightMg: 4350,
  ratePerGram: 410000,
  rateAppliedAt: '2026-10-22T06:00:00.000Z',
  maxAgeMinutes: 1560,
  ...over,
});

beforeEach(() => {
  ctx.language = 'ar';
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('goldRateIsStale (mirrors the server rule: whole minutes >= the limit)', () => {
  it('is fresh one minute before the limit and stale at it', () => {
    const g = gold({ rateAppliedAt: '2026-10-21T10:00:00.000Z', maxAgeMinutes: 1560 }); // 26 h before 12:00 next day
    expect(goldRateIsStale(g, Date.parse('2026-10-22T11:59:00.000Z'))).toBe(false);
    expect(goldRateIsStale(g, Date.parse('2026-10-22T12:00:00.000Z'))).toBe(true);
  });
  it('never trusts an unreadable timestamp', () => {
    expect(goldRateIsStale(gold({ rateAppliedAt: 'not a date' }), NOW)).toBe(true);
  });
});

describe('goldRateTime', () => {
  it('prints the Cairo clock whatever the server timezone is', () => {
    // 06:00Z is 09:00 in Cairo in October 2026 (EEST, UTC+3)
    expect(goldRateTime('2026-10-22T06:00:00.000Z', 'en')).toMatch(/\b9:00/);
  });
});

describe('GoldRateLine', () => {
  it('renders nothing without gold pricing', () => {
    expect(render(<GoldRateLine gold={null} />).container.innerHTML).toBe('');
  });

  it('states karat, weight and the per-gram rate in Arabic and English', () => {
    const ar = render(<GoldRateLine gold={gold()} />);
    expect(ar.getByTestId('gold-rate-line').textContent).toMatch(
      /عيار 21 · 4\.35 جم · سعر الجرام النهارده EGP 4100\.00/
    );
    cleanup();
    ctx.language = 'en';
    const en = render(<GoldRateLine gold={gold()} />);
    expect(en.getByTestId('gold-rate-line').textContent).toMatch(
      /21 karat · 4\.35 g · today's rate EGP 4100\.00 per gram/
    );
  });

  it('shows the gold / making split only when the payload carries it', () => {
    expect(render(<GoldRateLine gold={gold()} />).queryByTestId('gold-breakdown')).toBeNull();
    cleanup();
    const withSplit = render(
      <GoldRateLine gold={gold({ breakdown: { metalValue: 1_783_500, makingValue: 65_250 } })} />
    );
    expect(withSplit.getByTestId('gold-breakdown').textContent).toContain('EGP 17835.00');
    expect(withSplit.getByTestId('gold-breakdown').textContent).toContain('EGP 652.50');
  });

  it('says the piece cannot be ordered once the rate is past the limit, and not before', async () => {
    const { queryByTestId, rerender } = render(<GoldRateLine gold={gold()} />);
    await act(async () => {});
    expect(queryByTestId('gold-stale')).toBeNull();
    rerender(
      <GoldRateLine
        gold={gold({ rateAppliedAt: '2026-10-20T00:00:00.000Z', maxAgeMinutes: 1560 })}
      />
    );
    await act(async () => {});
    expect(queryByTestId('gold-stale')).not.toBeNull();
    // the last price is labelled by its time, and the sentence is the server's own
    expect(screen.getByTestId('gold-last-price').textContent).toMatch(/^آخر سعر /);
    expect(screen.getByTestId('gold-stale').textContent).toContain('مش هنقدر نكمّل الطلب دلوقتي');
  });

  it('turns stale while the page stays open', async () => {
    function Probe() {
      const stale = useGoldRateStale(
        gold({ rateAppliedAt: '2026-10-21T12:00:30.000Z', maxAgeMinutes: 1440 })
      );
      return <span data-testid="p">{stale ? 'stale' : 'fresh'}</span>;
    }
    render(<Probe />);
    await act(async () => {});
    expect(screen.getByTestId('p').textContent).toBe('fresh');
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(screen.getByTestId('p').textContent).toBe('stale');
  });

  it('never prints a margin or a rate source', () => {
    const html = render(
      <GoldRateLine gold={gold({ breakdown: { metalValue: 1, makingValue: 1 } })} />
    ).container.innerHTML;
    expect(html).not.toMatch(/margin|هامش|source|مصدر|marginBps/i);
  });
});

describe('PriceChangedNotice', () => {
  const lines = [{ id: 'l1', name: 'خاتم', previous: 2_050_000, current: 2_100_000 }];

  it('is a polite status with a neutral Continue button that calls back once, and takes focus', () => {
    const onContinue = vi.fn();
    render(<PriceChangedNotice onContinue={onContinue} lines={lines} />);
    const notice = screen.getByRole('status');
    expect(notice.getAttribute('aria-live')).toBe('polite');
    expect(notice.textContent).toContain('السعر اتحدّث');
    expect(document.activeElement).toBe(notice);
    fireEvent.click(screen.getByText('متابعة'));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('lists each moved line with the old price struck and the new one after it', () => {
    render(<PriceChangedNotice onContinue={() => {}} lines={lines} />);
    const li = screen.getByTestId('price-changed-lines').querySelector('li')!;
    expect(li.textContent).toContain('خاتم');
    const old = li.querySelector('.line-through')!;
    expect(old.textContent).toContain('20500.00');
    expect(old.getAttribute('aria-label')).toBe('السعر القديم');
    expect(li.textContent).toContain('21000.00');
  });

  it('does not strike an unchanged or unknown previous price', () => {
    render(
      <PriceChangedNotice
        onContinue={() => {}}
        lines={[
          { id: 'a', name: 'x', current: 5 },
          { id: 'b', name: 'y', previous: 5, current: 5 },
        ]}
      />
    );
    expect(document.querySelectorAll('.line-through').length).toBe(0);
  });

  it('disables Continue while busy', () => {
    render(<PriceChangedNotice onContinue={() => {}} busy />);
    expect((screen.getByText('متابعة') as HTMLButtonElement).disabled).toBe(true);
  });

  it('button is a 44px touch target and the block uses tokens only (no orange or amber)', () => {
    const { container } = render(<PriceChangedNotice onContinue={() => {}} lines={lines} />);
    expect(screen.getByText('متابعة').className).toMatch(/min-h-11/);
    expect(container.innerHTML).not.toMatch(/orange|amber|#[0-9a-f]{3,6}/i);
  });
});

describe('priceChangedLines', () => {
  it('keeps only moved lines and names them in the shopper language', () => {
    const items = [
      { id: '1', name: 'Ring', nameAr: 'خاتم', price: 10, previousPrice: 8, priceChanged: true },
      { id: '2', name: 'Chain', nameAr: 'سلسلة', price: 5 },
    ];
    expect(priceChangedLines(items, 'ar')).toEqual([
      { id: '1', name: 'خاتم', previous: 8, current: 10 },
    ]);
    expect(priceChangedLines(items, 'en')[0]!.name).toBe('Ring');
  });
});

describe('cart line mapping', () => {
  const server = (over: Record<string, unknown> = {}) =>
    ({
      id: 'l1',
      productId: 'p1',
      quantity: 1,
      product: { id: 'p1', name: 'Ring', slug: 'ring', price: 2_050_000 },
      unitPrice: 2_100_000,
      ...over,
    }) as Parameters<typeof mapServerItem>[0];

  it('carries the moved-price flag, the previous price and the public gold facts', () => {
    const line = mapServerItem(
      server({ priceChanged: true, previousUnitPrice: 2_050_000, goldPricing: gold() })
    );
    expect(line.price).toBe(2_100_000);
    expect(line.priceChanged).toBe(true);
    expect(line.previousPrice).toBe(2_050_000);
    expect(line.gold?.karat).toBe(21);
  });
  it('leaves an ordinary line untouched', () => {
    const line = mapServerItem(server());
    expect(line.priceChanged).toBeUndefined();
    expect(line.previousPrice).toBeUndefined();
    expect(line.gold).toBeUndefined();
  });
});

describe('wiring (source scan)', () => {
  const read = (p: string) => readFileSync(p, 'utf8');
  it('every buy control on the PDP reads the stale flag', () => {
    const src = read('apps/web/src/app/products/[slug]/ProductDetailClient.tsx');
    expect(src).toMatch(/const addDisabled = !buyableNow \|\| goldStale;/);
    expect((src.match(/disabled=\{!buyableNow \|\| goldStale\}/g) ?? []).length).toBe(2);
  });
  it('checkout maps the gold refusals to their own copy and shows the notice', () => {
    const src = read('apps/web/src/app/checkout/CheckoutClient.tsx');
    for (const c of ["case 'GOLD_RATE_STALE'", "case 'GOLD_PRICE_DRIFT'", '<PriceChangedNotice'])
      expect(src).toContain(c);
  });
  it('payment is held while a gold price notice is open', () => {
    const src = read('apps/web/src/app/checkout/CheckoutClient.tsx');
    expect(src).toMatch(/if \(goldPriceChanged\) \{\s+setCheckoutError\(/);
    expect((src.match(/goldPriceChanged/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
  it('the cart acknowledges through the public route with an empty body', () => {
    const api = read('apps/web/src/lib/api.ts');
    expect(api).toMatch(
      /'\/public\/cart\/acknowledge-prices'[\s\S]{0,80}body: JSON\.stringify\(\{\}\)/
    );
  });
});
