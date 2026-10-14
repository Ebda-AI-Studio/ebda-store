/**
 * SP8 — free-tier WhatsApp: the `wa.me` link helper + message builders.
 * Pure functions; no I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  WA_ME_MAX_ENCODED_LENGTH,
  buildCodConfirmationMessage,
  buildOrderQuestionMessage,
  buildOrderStatusMessage,
  buildProductShareMessage,
  buildStoreShareMessage,
  clampWaText,
  productUrl,
  resolveWaMeVisibility,
  waMeLink,
  waMeNumber,
  waMeShareLink,
} from '@ebda/shared';

describe('waMeNumber / waMeLink — Egyptian number normalisation', () => {
  const E = '201012345678';
  it.each([
    ['010 local', '01012345678', '201012345678'],
    ['011 local', '01112345678', '201112345678'],
    ['012 local', '01212345678', '201212345678'],
    ['015 local', '01512345678', '201512345678'],
    ['+20', '+201012345678', E],
    ['0020', '00201012345678', E],
    ['20 without plus', '201012345678', E],
    ['no trunk 0', '1012345678', E],
    ['spaces and dashes', '010 1234-5678', E],
    ['Arabic digits', '٠١٠١٢٣٤٥٦٧٨', E],
    ['Arabic digits +20', '+٢٠١٠١٢٣٤٥٦٧٨', E],
  ])('%s → digits-only international form', (_n, input, digits) => {
    expect(waMeNumber(input)).toBe(digits);
    expect(waMeLink(input)).toBe(`https://wa.me/${digits}`);
  });

  it.each([
    null,
    undefined,
    '',
    '   ',
    'abc',
    '0101234',
    '01312345678',
    '+966501234567',
    '0225551234',
  ])('invalid / missing %j → null (UI hides the button)', input => {
    expect(waMeNumber(input as string | null | undefined)).toBeNull();
    expect(waMeLink(input as string | null | undefined, 'hi')).toBeNull();
  });

  it('never emits a "+" or spaces in the number part', () => {
    expect(waMeLink('+20 101 234 5678', 'x')).toMatch(/^https:\/\/wa\.me\/\d{12}\?text=/);
  });
});

describe('waMeLink — text encoding and length guard', () => {
  it('URL-encodes Arabic text and round-trips', () => {
    const text = 'مرحباً، أريد تأكيد طلبي #123\nالإجمالي: 450.00 ج.م';
    const url = waMeLink('01012345678', text)!;
    expect(url).toContain('?text=%D9%85');
    expect(url).not.toMatch(/\s/);
    expect(decodeURIComponent(url.split('?text=')[1])).toBe(text);
  });

  it('truncates over-long text, keeps the encoded length bounded, ends with an ellipsis', () => {
    const url = waMeLink('01012345678', 'م'.repeat(5000))!;
    const encoded = url.split('?text=')[1];
    expect(encoded.length).toBeLessThanOrEqual(WA_ME_MAX_ENCODED_LENGTH);
    expect(decodeURIComponent(encoded).endsWith('…')).toBe(true);
  });

  it('does not split a surrogate pair when cutting', () => {
    const cut = clampWaText('😀'.repeat(2000), 10);
    expect(Array.from(cut)).toHaveLength(10);
    expect(cut.endsWith('…')).toBe(true);
    expect(() => encodeURIComponent(cut)).not.toThrow();
  });

  it('leaves short text untouched', () => {
    expect(clampWaText('hello')).toBe('hello');
  });

  it('share link has no recipient', () => {
    expect(waMeShareLink('a b')).toBe('https://wa.me/?text=a%20b');
  });
});

describe('resolveWaMeVisibility', () => {
  it('everything OFF without a valid number, regardless of toggles', () => {
    expect(resolveWaMeVisibility(null, {})).toEqual({
      hasNumber: false,
      productShare: false,
      orderQuestion: false,
      codConfirm: false,
    });
    expect(resolveWaMeVisibility('123', {}).productShare).toBe(false);
  });
  it('defaults ON where a number exists; false turns a toggle off', () => {
    expect(resolveWaMeVisibility('01012345678', undefined)).toEqual({
      hasNumber: true,
      productShare: true,
      orderQuestion: true,
      codConfirm: true,
    });
    expect(
      resolveWaMeVisibility('01012345678', { waMeProductShare: false, waMeCodConfirm: false })
    ).toEqual({ hasNumber: true, productShare: false, orderQuestion: true, codConfirm: false });
  });
});

const order = {
  orderNumber: 'EB-1042',
  items: [
    { name: 'Linen Shirt', nameAr: 'قميص كتان', quantity: 2 },
    { name: 'Leather Belt', nameAr: null, quantity: 1 },
  ],
  totalMinor: 125050,
  address: { address1: '12 Tahrir St', city: 'Dokki', state: 'Giza' },
  storeName: 'Nile Store',
};

describe('message builders (EGP formatting)', () => {
  it('COD confirmation — EN', () => {
    expect(buildCodConfirmationMessage({ locale: 'en', ...order })).toMatchInlineSnapshot(`
      "Hello Nile Store, I'd like to confirm my cash-on-delivery order #EB-1042.
      Items: 2× Linen Shirt, 1× Leather Belt
      Total: EGP 1,250.50
      Delivery address: 12 Tahrir St, Dokki, Giza
      Reply YES to confirm."
    `);
  });

  it('COD confirmation — AR', () => {
    expect(buildCodConfirmationMessage({ locale: 'ar', ...order, storeName: 'متجر النيل' }))
      .toMatchInlineSnapshot(`
        "مرحباً متجر النيل، أريد تأكيد طلبي رقم #EB-1042 (الدفع عند الاستلام).
        الأصناف: 2× قميص كتان، 1× Leather Belt
        الإجمالي: 1,250.50 ج.م
        عنوان التوصيل: 12 Tahrir St، Dokki، Giza
        رد بـ «نعم» للتأكيد."
      `);
  });

  it('caps the item list and omits empty address', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ name: `P${i}`, quantity: 1 }));
    const msg = buildCodConfirmationMessage({
      locale: 'en',
      orderNumber: '1',
      items: many,
      totalMinor: 100,
    });
    expect(msg).toContain('(+3 more)');
    expect(msg).not.toContain('Delivery address');
  });

  it('order question — EN + AR', () => {
    expect(buildOrderQuestionMessage({ locale: 'en', orderNumber: 'EB-1', storeName: 'S' })).toBe(
      'Hello S, I have a question about my order #EB-1.'
    );
    expect(buildOrderQuestionMessage({ locale: 'ar', orderNumber: 'EB-1' })).toBe(
      'مرحباً، عندي سؤال بخصوص طلبي رقم #EB-1.'
    );
  });

  it('product share uses the store origin and EGP price — EN + AR', () => {
    const url = productUrl({ slug: 'nile', domain: null }, 'linen-shirt');
    expect(url).toBe('https://nile.ebda.app/products/linen-shirt');
    expect(productUrl({ slug: 'nile', domain: 'nile-store.com' }, 'a b')).toBe(
      'https://nile-store.com/products/a%20b'
    );
    expect(
      buildProductShareMessage({ locale: 'en', productName: 'Linen Shirt', priceMinor: 49900, url })
    ).toMatchInlineSnapshot(`
      "Check this out: Linen Shirt — EGP 499
      https://nile.ebda.app/products/linen-shirt"
    `);
    expect(
      buildProductShareMessage({ locale: 'ar', productName: 'قميص كتان', priceMinor: 49900, url })
    ).toMatchInlineSnapshot(`
      "شوف ده: قميص كتان — 499 ج.م
      https://nile.ebda.app/products/linen-shirt"
    `);
  });

  it('store share — EN + AR', () => {
    const url = 'https://nile.ebda.app';
    expect(buildStoreShareMessage({ locale: 'en', storeName: 'Nile', url })).toMatchInlineSnapshot(`
      "My new store "Nile" is open! Come take a look:
      https://nile.ebda.app"
    `);
    expect(buildStoreShareMessage({ locale: 'ar', storeName: 'النيل', url }))
      .toMatchInlineSnapshot(`
      "متجري الجديد «النيل» أصبح مفتوحاً! تفضلوا بالزيارة:
      https://nile.ebda.app"
    `);
  });

  it('merchant order-status message — EN + AR', () => {
    expect(
      buildOrderStatusMessage({
        locale: 'en',
        orderNumber: 'EB-1',
        status: 'shipped',
        customerName: 'Mona',
        storeName: 'Nile',
      })
    ).toBe('Hello Mona, this is Nile. Your order #EB-1 is shipped.');
    expect(
      buildOrderStatusMessage({ locale: 'ar', orderNumber: 'EB-1', status: 'delivered' })
    ).toBe('مرحباً، معك المتجر. طلبك رقم #EB-1 تم تسليمه.');
  });
});
