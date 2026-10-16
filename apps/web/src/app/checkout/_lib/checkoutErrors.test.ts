import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  orderLocale,
  personalisationRequiredCopy,
  subscriptionRequiredCopy,
  variantRequiredCopy,
} from './checkoutErrors';

const en = (e: string) => e;
const ar = (_e: string, a: string) => a;

describe('subscriptionRequiredCopy', () => {
  it('maps SUBSCRIPTION_REQUIRED to the shopper message in both languages', () => {
    expect(subscriptionRequiredCopy('SUBSCRIPTION_REQUIRED', en)).toBe(
      'This store is not taking orders right now. Please try again later.'
    );
    expect(subscriptionRequiredCopy('SUBSCRIPTION_REQUIRED', ar)).toBe(
      'المتجر لا يستقبل طلبات حالياً. حاول مرة أخرى لاحقاً.'
    );
  });
  it('ignores other codes', () => {
    expect(subscriptionRequiredCopy('PAYMENT_FAILED', en)).toBeNull();
  });
});

const tAr = (_en: string, ar: string) => ar;
const tEn = (en: string) => en;

describe('personalisationRequiredCopy', () => {
  const details = {
    productIds: ['p1'],
    products: [
      {
        productId: 'p1',
        name: 'Linen Abaya',
        nameAr: 'عباية كتان',
        label: '',
        labelAr: 'الاسم للتطريز',
      },
    ],
  };

  it('ignores other codes', () => {
    expect(personalisationRequiredCopy('EMPTY_CART', details, tAr, 'ar')).toBeNull();
  });

  it('names the field and the item, Arabic first', () => {
    expect(personalisationRequiredCopy('PERSONALISATION_REQUIRED', details, tAr, 'ar')).toBe(
      'اكتب الاسم للتطريز لـ عباية كتان من صفحة المنتج.'
    );
  });

  it('an Arabic-only label reads as the platform default in English, never Arabic or blank (F4)', () => {
    expect(personalisationRequiredCopy('PERSONALISATION_REQUIRED', details, tEn, 'en')).toBe(
      'Add “your personalisation” for Linen Abaya on its product page.'
    );
  });

  it('still explains itself without details', () => {
    expect(personalisationRequiredCopy('PERSONALISATION_REQUIRED', undefined, tAr, 'ar')).toBe(
      'يوجد منتج في سلتك يحتاج إلى تخصيص. اكتبه من صفحة المنتج.'
    );
  });
});

describe('variantRequiredCopy (FU46 M-6)', () => {
  const tEn = (en: string) => en;
  const tAr = (_en: string, ar: string) => ar;
  const details = { products: [{ name: 'Linen Abaya', nameAr: 'عباية كتان' }, { name: 'Scarf' }] };
  it('names the items, in the shopper language, falling back across languages', () => {
    expect(variantRequiredCopy('VARIANT_REQUIRED', details, tEn, 'en')).toBe(
      'Please choose a size for Linen Abaya, Scarf on its product page.'
    );
    expect(variantRequiredCopy('VARIANT_REQUIRED', details, tAr, 'ar')).toBe(
      'يرجى اختيار المقاس لـ عباية كتان، Scarf من صفحة المنتج.'
    );
  });
  it('still explains itself without details, and ignores other codes', () => {
    expect(variantRequiredCopy('VARIANT_REQUIRED', undefined, tAr, 'ar')).toContain('المقاس');
    expect(variantRequiredCopy('EMPTY_CART', details, tEn, 'en')).toBeNull();
  });
});

describe('checkout order payload locale', () => {
  it('maps the storefront language to the order locale', () => {
    expect(orderLocale('ar')).toBe('ar');
    expect(orderLocale('en')).toBe('en');
    expect(orderLocale('fr')).toBe('en');
  });

  it('CheckoutClient sends it on api.createOrder (Arabic variant snapshot + email language)', () => {
    const src = readFileSync(join(__dirname, '..', 'CheckoutClient.tsx'), 'utf8');
    const call = src.slice(src.indexOf('api.createOrder({'));
    const body = call.slice(0, call.indexOf('});'));
    expect(body).toContain('locale: orderLocale(language)');
  });
});
