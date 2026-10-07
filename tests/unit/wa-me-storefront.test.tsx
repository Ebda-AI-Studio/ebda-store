/**
 * SP8 — storefront wa.me buttons render ONLY when the store has a valid
 * Egyptian WhatsApp number (and the merchant toggle is not off), in the
 * storefront's locale. `react-dom/server` markup — no DOM environment here.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const storeState = {
  store: {
    name: 'Nile Store',
    nameAr: 'متجر النيل',
    slug: 'nile',
    domain: undefined as string | undefined,
    whatsapp: '+201012345678' as string | undefined,
    theme: {} as Record<string, unknown>,
  },
};
const languageState = { language: 'en' as 'en' | 'ar' };

vi.mock('@web/contexts/StoreContext', () => ({ useStore: () => storeState }));
vi.mock('@web/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: languageState.language,
    isRtl: languageState.language === 'ar',
    t: (en: string, ar?: string) => (languageState.language === 'ar' ? (ar ?? en) : en),
  }),
}));

const { WaMeProductButton, WaMeCodConfirmButton, WaMeOrderQuestionButton } =
  await import('@web/templates/shared/WaMeButtons');

const product = { slug: 'linen-shirt', name: 'Linen Shirt', nameAr: 'قميص كتان' };
const order = {
  orderNumber: 'EB-1042',
  total: 125050,
  items: [{ quantity: 2, product: { name: 'Linen Shirt', nameAr: 'قميص كتان' } }],
  shippingAddress: { address1: '12 Tahrir St', city: 'Dokki', state: 'Giza' },
};

function setup(over: Partial<typeof storeState.store> = {}, lang: 'en' | 'ar' = 'en') {
  storeState.store = {
    name: 'Nile Store',
    nameAr: 'متجر النيل',
    slug: 'nile',
    domain: undefined,
    whatsapp: '+201012345678',
    theme: {},
    ...over,
  };
  languageState.language = lang;
}
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const hrefOf = (markup: string) =>
  decodeURIComponent(markup.match(/href="([^"]+)"/)![1].replace(/&amp;/g, '&'));

describe('storefront wa.me buttons', () => {
  it('product page: renders a wa.me link to the store number with the product + store-origin URL', () => {
    setup();
    const out = html(<WaMeProductButton product={product} priceMinor={49900} />);
    expect(out).toContain('data-testid="wa-me-product"');
    expect(out).toContain('href="https://wa.me/201012345678?text=');
    expect(hrefOf(out)).toContain('Linen Shirt — EGP 499');
    expect(hrefOf(out)).toContain('https://nile.ebda.app/products/linen-shirt');
    expect(out).toContain('Ask or share on WhatsApp');
  });

  it('no number → no button on any surface', () => {
    for (const whatsapp of [undefined, '', '12345', '+966501234567']) {
      setup({ whatsapp });
      expect(html(<WaMeProductButton product={product} priceMinor={1} />)).toBe('');
      expect(html(<WaMeCodConfirmButton order={order} />)).toBe('');
      expect(html(<WaMeOrderQuestionButton orderNumber="EB-1" />)).toBe('');
    }
  });

  it('each merchant toggle hides only its own button', () => {
    setup({ theme: { waMeProductShare: false } });
    expect(html(<WaMeProductButton product={product} />)).toBe('');
    expect(html(<WaMeOrderQuestionButton orderNumber="1" />)).not.toBe('');
    setup({ theme: { waMeOrderQuestion: false } });
    expect(html(<WaMeOrderQuestionButton orderNumber="1" />)).toBe('');
    expect(html(<WaMeCodConfirmButton order={order} />)).not.toBe('');
    setup({ theme: { waMeCodConfirm: false } });
    expect(html(<WaMeCodConfirmButton order={order} />)).toBe('');
  });

  it('COD thank-you: prominent "Confirm on WhatsApp" prefilled with the COD message', () => {
    setup();
    const out = html(<WaMeCodConfirmButton order={order} />);
    expect(out).toContain('Confirm on WhatsApp');
    const text = hrefOf(out);
    expect(text).toContain('#EB-1042');
    expect(text).toContain('Total: EGP 1,250.50');
    expect(text).toContain('Reply YES to confirm.');
  });

  it('follows the storefront locale (Arabic)', () => {
    setup({}, 'ar');
    const cod = html(<WaMeCodConfirmButton order={order} />);
    expect(cod).toContain('أكّد على واتساب');
    expect(hrefOf(cod)).toContain('الإجمالي: 1,250.50 ج.م');
    expect(hrefOf(cod)).toContain('مرحباً متجر النيل');
    const q = html(<WaMeOrderQuestionButton orderNumber="EB-9" />);
    expect(q).toContain('اسأل عن هذا الطلب');
    expect(hrefOf(q)).toContain('عندي سؤال بخصوص طلبي رقم #EB-9');
  });

  it('uses the custom domain for the product URL', () => {
    setup({ domain: 'nile-store.com' });
    expect(hrefOf(html(<WaMeProductButton product={product} />))).toContain(
      'https://nile-store.com/products/linen-shirt'
    );
  });
});
