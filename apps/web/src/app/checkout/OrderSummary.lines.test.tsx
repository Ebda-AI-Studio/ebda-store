// @vitest-environment jsdom
/**
 * IA-02 (P1): the checkout summary hid colour / size / length, the one step where the buyer commits.
 * IA-07 / a11y P1-1: the quantity badge was white on muted (1.77:1 on Lookbook), physically placed
 * (-right-1) and clipped by the thumbnail's overflow-hidden.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'ar', isRtl: true, t: (_en: string, ar: string) => ar }),
  translations: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock('../../hooks/useNumerals', () => ({
  useNumerals: () => ({ localize: (v: string | number) => String(v) }),
  useStoreNumerals: () => 'latn',
}));
vi.mock('../../hooks/useLocalePrice', () => ({ useLocalePrice: () => (n: number) => `${n} ج.م` }));
vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ alt }: { alt?: string }) => React.createElement('img', { alt }),
}));

import { OrderSummary } from './OrderSummary';
import { BundleLine } from '../../components/BundleLine';

afterEach(cleanup);

const item = {
  id: 'l1',
  productId: 'p1',
  quantity: 2,
  price: 149000,
  variantTitle: 'Rose / S / 52',
  variantTitleAr: 'وردي / S / 52',
  product: {
    id: 'p1',
    name: 'Linen abaya',
    nameAr: 'عباية كتان',
    slug: 'x',
    images: [{ id: 'i', url: 'u' }],
  },
};
const base = {
  items: [item] as never,
  subtotal: 298000,
  discount: 0,
  shipping: 0,
  tax: 0,
  taxRatePercent: 0,
  taxIncludedInPrice: false,
  total: 298000,
  freeShipping: false,
  couponCode: '',
  onCouponCodeChange: () => {},
  appliedCoupon: null,
  onApplyCoupon: () => {},
  onRemoveCoupon: () => {},
  couponError: '',
};

describe('checkout OrderSummary lines', () => {
  it('IA-02: each line names its variant in the page language', () => {
    const { container } = render(<OrderSummary {...base} />);
    expect(container.textContent).toContain('وردي');
    expect(container.textContent).toContain('52');
  });
  it('IA-07: the quantity badge is an ink pair, logical, outside the clipped thumbnail', () => {
    const { getByTestId } = render(<OrderSummary {...base} />);
    const badge = getByTestId('line-qty-badge');
    expect(badge.className).toContain('bg-foreground');
    expect(badge.className).toContain('text-background');
    expect(badge.className).toContain('-end-1');
    expect(badge.className).not.toMatch(/-right-1|text-white|bg-muted-foreground/);
    expect(badge.parentElement!.className).not.toContain('overflow-hidden');
  });
  it('IA-07: the bundle row badge follows the same rule', () => {
    const { getByTestId } = render(
      <BundleLine variant="row" name="Box" image={null} quantity={3} total={1} available isRtl />
    );
    const badge = getByTestId('line-qty-badge');
    expect(badge.className).toContain('bg-foreground');
    expect(badge.parentElement!.className).not.toContain('overflow-hidden');
  });
});
