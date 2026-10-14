import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  orderLocale,
  personalisationRequiredCopy,
  subscriptionRequiredCopy,
} from './checkoutErrors';

const en = (e: string) => e;
const ar = (_e: string, a: string) => a;

describe('subscriptionRequiredCopy', () => {
  it('maps SUBSCRIPTION_REQUIRED to the shopper message in both languages', () => {
    expect(subscriptionRequiredCopy('SUBSCRIPTION_REQUIRED', en)).toBe(
      'This store is not taking orders right now. Please try again later.'
    );
    expect(subscriptionRequiredCopy('SUBSCRIPTION_REQUIRED', ar)).toBe(
      'المتجر مش بيستقبل طلبات دلوقتي. جرّب تاني بعدين.'
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

  it('falls back to the Arabic label on English, never blank', () => {
    expect(personalisationRequiredCopy('PERSONALISATION_REQUIRED', details, tEn, 'en')).toBe(
      'Add “الاسم للتطريز” for Linen Abaya on its product page.'
    );
  });

  it('still explains itself without details', () => {
    expect(personalisationRequiredCopy('PERSONALISATION_REQUIRED', undefined, tAr, 'ar')).toBe(
      'في منتج في سلتك محتاج تخصيص. اكتبه من صفحة المنتج.'
    );
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
