import { describe, it, expect } from 'vitest';
import { IntlMessageFormat } from 'intl-messageformat';
import en from './messages/en.json';
import ar from './messages/ar.json';

const fmt = (m: string, loc: string, v: Record<string, unknown>) =>
  String(new IntlMessageFormat(m, loc).format(v as never));

describe('dashboard pulse sentences (D2)', () => {
  const s = en.stores.dashboard.pulse.sentence;
  it('EN pluralises orders: "1 order", "8 orders"', () => {
    expect(fmt(s.flat, 'en', { orders: '1', ordersN: 1 })).toBe(
      'Same as the previous period, from 1 order.'
    );
    expect(fmt(s.up, 'en', { percent: 25, orders: '8', ordersN: 8 })).toContain('from 8 orders.');
  });
  it('AR reads naturally for 1, 2, 5', () => {
    const a = ar.stores.dashboard.pulse.sentence;
    expect(fmt(a.unknown, 'ar', { orders: '1', ordersN: 1 })).toBe('من طلب واحد.');
    expect(fmt(a.unknown, 'ar', { orders: '2', ordersN: 2 })).toBe('من طلبين.');
    expect(fmt(a.unknown, 'ar', { orders: '5', ordersN: 5 })).toBe('من 5 طلبات.');
  });
  it('has a "new" sentence in both languages', () => {
    expect(en.stores.dashboard.pulse.sentence.new).toBeTruthy();
    expect(ar.stores.dashboard.pulse.sentence.new).toBeTruthy();
  });
});
