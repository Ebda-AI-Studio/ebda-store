import { describe, it, expect } from 'vitest';
import { barcodeImgHtml } from '../../apps/api/src/services/email-templates/_barcode';
import { orderConfirmationTemplate } from '../../apps/api/src/services/email-templates/order-confirmation';
import { subscriptionBillingTemplate } from '../../apps/api/src/services/email-templates/subscription-billing';

const BC = {
  url: 'https://cdn.ebda.app/stores/3f2a91c4-7b1e-4d0a-9c55-0e8a1f2b3c4d/barcodes/0123456789abcdef0123456789abcdef.png',
  width: 360,
  height: 120,
};

describe('barcodeImgHtml', () => {
  it('is an absolute-https img with width, height and an alt that names the number', () => {
    const ar = barcodeImgHtml(BC, 'ORD-T5JK9Q-AB3XY', 'ar', 'order');
    expect(ar).toContain(`src="${BC.url}"`);
    expect(ar).toContain('width="360"');
    expect(ar).toContain('height="120"');
    expect(ar).toContain('alt="رقم الطلب ORD-T5JK9Q-AB3XY"');
    expect(barcodeImgHtml(BC, 'ORD-T5JK9Q-AB3XY', 'en', 'order')).toContain(
      'alt="Order number ORD-T5JK9Q-AB3XY"'
    );
    expect(barcodeImgHtml(BC, 'EBD-0000000000000001', 'ar', 'billing')).toContain(
      'alt="رقم الدفعة EBD-0000000000000001"'
    );
  });
  it('is empty when there is no image, or the url is not https', () => {
    expect(barcodeImgHtml(null, 'N', 'en', 'order')).toBe('');
    expect(barcodeImgHtml(undefined, 'N', 'ar', 'order')).toBe('');
    expect(barcodeImgHtml({ ...BC, url: 'http://x/y.png' }, 'N', 'en', 'order')).toBe('');
    expect(barcodeImgHtml({ ...BC, url: 'javascript:alert(1)' }, 'N', 'en', 'order')).toBe('');
  });
  it('escapes the number and the url', () => {
    const h = barcodeImgHtml({ ...BC, url: 'https://x/a"b.png' }, '"><script>', 'en', 'order');
    expect(h).not.toContain('<script>');
    expect(h).not.toContain('a"b');
  });
});

const order = (extra = {}) =>
  ({
    orderNumber: 'ORD-T5JK9Q-AB3XY',
    customerName: 'Sara',
    customerEmail: 's@x.com',
    items: [],
    subtotal: 100,
    shipping: 0,
    total: 100,
    currency: 'EGP',
    shippingAddress: { firstName: 'S', lastName: 'A' },
    ...extra,
  }) as never;

describe('order confirmation email', () => {
  for (const lang of ['en', 'ar'] as const) {
    it(`${lang}: image when ready; copy otherwise byte-identical (text only fallback)`, () => {
      const without = orderConfirmationTemplate[lang](order(), 'S');
      const withImg = orderConfirmationTemplate[lang](order({ barcode: BC }), 'S');
      expect(withImg).toContain('<img');
      expect(without).not.toContain('<img');
      expect(withImg.replace(/\s*<img[^>]*>/, '')).toBe(without);
      expect(without).toContain('ORD-T5JK9Q-AB3XY'); // the number as text, always
      expect(withImg.toLowerCase()).not.toContain('#ff6e01');
    });
  }
});

describe('billing payment_confirmed email', () => {
  const d = (extra = {}) =>
    ({
      kind: 'payment_confirmed',
      storeName: 'S',
      planName: 'Growth',
      amountMinor: 0,
      paidUntil: '2026-11-21',
      billingUrl: 'https://a.b/c',
      ...extra,
    }) as never;
  for (const lang of ['en', 'ar'] as const) {
    it(`${lang}: palm image only on payment_confirmed, otherwise identical`, () => {
      const without = subscriptionBillingTemplate[lang](d());
      const withImg = subscriptionBillingTemplate[lang](
        d({ barcode: BC, paymentNumber: 'EBD-0000000000000001' })
      );
      expect(withImg.replace(/\s*<img[^>]*>/, '')).toBe(without);
      expect(withImg).toContain('<img');
      const other = subscriptionBillingTemplate[lang]({
        ...(d() as object),
        kind: 'payment_rejected',
        reason: 'x',
        barcode: BC,
        paymentNumber: 'EBD-1',
      } as never);
      expect(other).not.toContain('<img');
    });
  }
});
