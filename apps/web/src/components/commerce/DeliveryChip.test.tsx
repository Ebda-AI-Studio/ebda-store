// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

let lang: 'en' | 'ar' = 'ar';
let settings: Record<string, unknown> | undefined;
let zones: unknown[] = [];

vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: lang,
    isRtl: lang === 'ar',
    t: (en: string, ar: string) => (lang === 'ar' ? ar : en),
  }),
}));
// A fresh store id per test (the chip caches zones per store), stable across renders.
let storeId = 'store-0';
let n = 0;
vi.mock('@/contexts/StoreContext', () => ({
  useStore: () => ({ store: { id: storeId, timezone: 'Africa/Cairo', settings } }),
}));
vi.mock('@/hooks/useNumerals', () => ({
  useStoreNumerals: () => 'latn',
  useNumerals: () => ({ localize: (v: string | number) => String(v), numerals: 'latn' }),
}));
vi.mock('@/lib/shipping-public', () => ({
  fetchPublicShippingZones: vi.fn(async () => zones),
}));

import { DeliveryChip } from './DeliveryChip';

const zone = (over: Record<string, unknown> = {}) => ({
  name: 'Cairo',
  deliveryFee: 0,
  freeShippingThreshold: null,
  estimatedDaysMin: 1,
  estimatedDaysMax: 3,
  estimatedDays: null,
  ...over,
});

beforeEach(() => {
  storeId = `store-${++n}`;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  lang = 'ar';
  settings = undefined;
  zones = [];
});

describe('DeliveryChip', () => {
  it('no zone hides chip', async () => {
    zones = [];
    const { container } = render(<DeliveryChip leadTimeDays={5} />);
    await new Promise(r => setTimeout(r, 20));
    expect(container.innerHTML).toBe('');
  });

  it('a zone with no day numbers hides chip, never 0 or NaN', async () => {
    zones = [zone({ estimatedDaysMin: null, estimatedDaysMax: null })];
    const { container } = render(<DeliveryChip leadTimeDays={null} />);
    await new Promise(r => setTimeout(r, 20));
    expect(container.innerHTML).toBe('');
    expect(container.textContent).not.toMatch(/NaN|\b0\b/);
  });

  it('shows the arabic window and the made-to-order line', async () => {
    zones = [zone()];
    render(<DeliveryChip leadTimeDays={5} />);
    const chip = await screen.findByTestId('delivery-chip');
    expect(chip.textContent).toContain('يوصلك بين');
    expect(chip.textContent).toContain('بيتجهز خصيصًا لك في 5 أيام');
    // The "و" attaches to the second date.
    expect(chip.textContent).toMatch(/بين \S+ \d+ \S+ و\S+ \d+ \S+/);
  });

  it.each([
    [1, 'ar', 'بيتجهز خصيصًا لك في يوم واحد'],
    [2, 'ar', 'بيتجهز خصيصًا لك في يومين'],
    [5, 'ar', 'بيتجهز خصيصًا لك في 5 أيام'],
    [11, 'ar', 'بيتجهز خصيصًا لك في 11 يومًا'],
    [1, 'en', 'Made for you in 1 day'],
    [2, 'en', 'Made for you in 2 days'],
    [5, 'en', 'Made for you in 5 days'],
    [11, 'en', 'Made for you in 11 days'],
  ] as const)('lead time %i in %s reads %j', async (n, l, expected) => {
    lang = l;
    zones = [zone()];
    render(<DeliveryChip leadTimeDays={n} />);
    const chip = await screen.findByTestId('delivery-chip');
    const lines = Array.from(chip.querySelectorAll('p')).map(p => p.textContent);
    expect(lines[1]).toBe(expected);
  });

  it('english window reads "Arrives Thu 15 Oct - ..." with no comma after the weekday', async () => {
    lang = 'en';
    zones = [zone({ estimatedDaysMin: 1, estimatedDaysMax: 1 })];
    render(<DeliveryChip leadTimeDays={null} />);
    const chip = await screen.findByTestId('delivery-chip');
    expect(chip.textContent).toContain('Arrives Thu 15 Oct');
  });

  it('single day reads "يوصلك X" and omits the lead line when ready to ship', async () => {
    zones = [zone({ estimatedDaysMin: 1, estimatedDaysMax: 1 })];
    render(<DeliveryChip leadTimeDays={null} />);
    const chip = await screen.findByTestId('delivery-chip');
    expect(chip.textContent).toContain('يوصلك');
    expect(chip.textContent).not.toContain('بين');
    expect(chip.textContent).not.toContain('بيتجهز');
  });

  it('uses the store-wide deliveryDays when zones carry no numbers', async () => {
    zones = [zone({ estimatedDaysMin: null, estimatedDaysMax: null })];
    settings = { deliveryDays: { min: 2, max: 4 } };
    lang = 'en';
    render(<DeliveryChip leadTimeDays={null} />);
    await waitFor(() =>
      expect(screen.getByTestId('delivery-chip').textContent).toContain('Arrives')
    );
  });

  it('ignores a malformed store-wide deliveryDays', async () => {
    zones = [];
    settings = { deliveryDays: { min: 9, max: 1 } };
    const { container } = render(<DeliveryChip leadTimeDays={null} />);
    await new Promise(r => setTimeout(r, 20));
    expect(container.innerHTML).toBe('');
  });

  it('skips only Friday by default and honours the store deliveryOffDays', async () => {
    lang = 'en';
    zones = [zone({ estimatedDaysMin: 1, estimatedDaysMax: 3 })];
    const first = render(<DeliveryChip leadTimeDays={null} />);
    // Wed 14 +3 business days, Friday off: Thu 15 - Sun 18.
    expect((await screen.findByTestId('delivery-chip')).textContent).toBe(
      'Arrives Thu 15 Oct – Sun 18 Oct'
    );
    first.unmount();
    storeId = `store-${++n}`;
    settings = { deliveryOffDays: [] };
    render(<DeliveryChip leadTimeDays={null} />);
    expect((await screen.findByTestId('delivery-chip')).textContent).toBe(
      'Arrives Thu 15 Oct – Sat 17 Oct'
    );
  });

  it('ignores a malformed deliveryOffDays and keeps the Friday default', async () => {
    lang = 'en';
    zones = [zone({ estimatedDaysMin: 1, estimatedDaysMax: 3 })];
    settings = { deliveryOffDays: [0, 1, 2, 3, 4, 5, 6] };
    render(<DeliveryChip leadTimeDays={null} />);
    expect((await screen.findByTestId('delivery-chip')).textContent).toContain('Sun 18 Oct');
  });
});
