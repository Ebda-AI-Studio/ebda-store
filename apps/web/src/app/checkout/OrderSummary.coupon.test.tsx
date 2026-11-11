// @vitest-environment jsdom
/**
 * a11y re-audit P1-N1 (2026-10-16): a failed coupon printed a plain <p> next to the field: no
 * live region, the field not marked invalid or tied to it, Enter in the field did nothing, and
 * the API's English message showed on the Arabic page. The error is an id'd role=alert the field
 * points at, focus returns to the field, Enter applies, and the copy comes from the error CODE.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';

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
import { couponErrorCopy } from '../../lib/coupon-errors';

afterEach(cleanup);

const base = {
  items: [] as never,
  subtotal: 100,
  discount: 0,
  shipping: 0,
  tax: 0,
  taxRatePercent: 0,
  taxIncludedInPrice: false,
  total: 100,
  freeShipping: false,
  couponCode: 'NOPE',
  onCouponCodeChange: () => {},
  appliedCoupon: null,
  onApplyCoupon: () => {},
  onRemoveCoupon: () => {},
  couponError: '',
};

describe('failed coupon (P1-N1)', () => {
  it('the error is an alert the field points at, and the field is invalid', () => {
    const { getByRole, getByLabelText } = render(
      <OrderSummary {...base} couponError="الكود ده مش صالح." />
    );
    const alert = getByRole('alert');
    const field = getByLabelText('كود الخصم') as HTMLInputElement;
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(alert.id);
    expect(alert.id).not.toBe('');
  });
  it('focus returns to the field when an error arrives', () => {
    const { rerender, getByLabelText } = render(<OrderSummary {...base} />);
    rerender(<OrderSummary {...base} couponError="الكود ده مش صالح." />);
    expect(document.activeElement).toBe(getByLabelText('كود الخصم'));
  });
  it('Enter in the field applies the code', () => {
    const onApplyCoupon = vi.fn();
    const { getByLabelText } = render(<OrderSummary {...base} onApplyCoupon={onApplyCoupon} />);
    fireEvent.keyDown(getByLabelText('كود الخصم'), { key: 'Enter' });
    expect(onApplyCoupon).toHaveBeenCalledTimes(1);
  });
  it('the copy comes from the error code, in the page language, never the API message', () => {
    const t = (_en: string, ar: string) => ar;
    expect(couponErrorCopy('INVALID_COUPON', t)).toBe('الكود ده مش صالح.');
    expect(couponErrorCopy('COUPON_EXPIRED', t)).toMatch(/انتهى/);
    expect(couponErrorCopy(undefined, (en: string) => en)).toBe("This code isn't valid.");
  });
  it('checkout and cart never show the API message', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const f of ['CheckoutClient.tsx', '../cart/CartClient.tsx']) {
      expect(readFileSync(join(__dirname, f), 'utf8')).not.toMatch(/result\.error\?\.message/);
    }
  });
});

describe('shipping line (QA-C3/C4)', () => {
  const ship = (over: Record<string, unknown>) =>
    render(React.createElement(OrderSummary, { ...base, ...over } as never)).container
      .textContent ?? '';
  it('never says free when the store has no delivery rates', () => {
    const text = ship({ shippingToConfirm: true, shippingAreaChosen: true });
    expect(text).toContain('بيتحدد مع المتجر');
    expect(text).not.toContain('Free');
  });
  it('updates from "pick an area" once an area is chosen and the fee is 0', () => {
    expect(ship({ shippingAreaChosen: false })).toContain('اختر المنطقة');
    cleanup();
    expect(ship({ shippingAreaChosen: true })).not.toContain('اختر المنطقة');
  });
});
