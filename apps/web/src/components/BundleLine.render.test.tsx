// @vitest-environment jsdom
/**
 * #2053 — the bundle stock note, rendered. The server refuses a box when a
 * component has less stock than the requested quantity needs (the atomic
 * decrement in OrderService.create, Ruling T5-c), so the note fires on
 * `available < quantity` — and it must name the case: sold out vs. only N.
 * Both layouts (`card` on /cart, `row` in the checkout summary), both
 * languages.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

let lang: 'en' | 'ar' = 'en';
vi.mock('../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    isRtl: lang === 'ar',
    t: (en: string, ar: string) => (lang === 'ar' ? ar : en),
  }),
}));
vi.mock('../hooks/useNumerals', () => ({
  useNumerals: () => ({ localize: (s: unknown) => String(s) }),
}));
vi.mock('../hooks/useLocalePrice', () => ({
  useLocalePrice: () => (n: number) => `${n / 1000} KWD`,
}));
vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ alt }: { alt?: string }) => React.createElement('img', { alt }),
}));

import { BundleLine } from './BundleLine';

const base = { name: 'Ramadan Box', nameAr: 'صندوق رمضان', image: null, total: 12000 };

afterEach(() => {
  cleanup();
  lang = 'en';
});

const note = (c: HTMLElement) => c.querySelector('[data-bundle-stock-note]')?.textContent ?? null;

describe.each(['card', 'row'] as const)('BundleLine stock note (%s)', variant => {
  it('renders nothing when enough stock covers the quantity', () => {
    const { container } = render(
      <BundleLine {...base} quantity={2} available={2} variant={variant} />
    );
    expect(note(container)).toBeNull();
  });

  it('renders nothing when availability is unknown', () => {
    const { container } = render(<BundleLine {...base} quantity={2} variant={variant} />);
    expect(note(container)).toBeNull();
  });

  it('says "Only N available" — not "Out of stock" — for a partial shortfall', () => {
    const { container } = render(
      <BundleLine {...base} quantity={5} available={2} variant={variant} />
    );
    expect(note(container)).toBe('Only 2 available');
  });

  it('says "Out of stock" when none are left', () => {
    const { container } = render(
      <BundleLine {...base} quantity={1} available={0} variant={variant} />
    );
    expect(note(container)).toBe('Out of stock');
  });

  it('localizes both cases in Arabic', () => {
    lang = 'ar';
    const partial = render(<BundleLine {...base} quantity={5} available={2} variant={variant} />);
    expect(note(partial.container)).toBe('المتوفر 2 فقط');
    cleanup();
    const none = render(<BundleLine {...base} quantity={1} available={0} variant={variant} />);
    expect(note(none.container)).toBe('غير متوفر');
  });
});
