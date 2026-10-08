import { describe, expect, it } from 'vitest';
import {
  orderStatusLabel,
  orderPaymentStatusLabel,
  paymentStatusLabel,
  paymentProviderLabel,
  paymentMethodLabel,
} from '../../apps/web/src/lib/order-labels';
import { formatEstimatedDays } from '../../apps/web/src/lib/delivery-estimate';

const ORDER_STATUSES = [
  'pending',
  'awaiting_payment_confirmation',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
];
const ORDER_PAYMENT_STATUSES = ['unpaid', 'paid', 'failed', 'refunded', 'disputed'];
const PAYMENT_STATUSES = [
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled',
  'expired',
  'refunded',
  'partially_refunded',
  'disputed',
  'cod_pending',
];
const PROVIDERS = ['cod', 'instapay', 'paymob', 'kashier', 'fawry'];

const noRaw = (s: string) => !/_/.test(s) && !/^[a-z]+$/.test(s);

describe('order labels', () => {
  it.each([
    ['orderStatusLabel', orderStatusLabel, ORDER_STATUSES],
    ['orderPaymentStatusLabel', orderPaymentStatusLabel, ORDER_PAYMENT_STATUSES],
    ['paymentStatusLabel', paymentStatusLabel, PAYMENT_STATUSES],
    ['paymentProviderLabel', paymentProviderLabel, PROVIDERS],
  ])('%s covers every enum value in both languages', (_n, fn, values) => {
    for (const v of values) {
      const ar = fn(v, 'ar');
      const en = fn(v, 'en');
      expect(ar, v).toMatch(/[؀-ۿ]/);
      expect(noRaw(en), `${v} -> ${en}`).toBe(true);
      expect(noRaw(ar), `${v} -> ${ar}`).toBe(true);
    }
  });

  it('never prints raw snake_case for unknown values', () => {
    for (const fn of [orderStatusLabel, orderPaymentStatusLabel, paymentStatusLabel]) {
      expect(fn('some_new_state', 'en')).toBe('Status unavailable');
      expect(fn(undefined, 'ar')).toBe('الحالة غير متاحة');
    }
    expect(paymentMethodLabel('MIGS_THING', 'en')).toBe('Other method');
    expect(paymentProviderLabel('stripe', 'ar')).toBe('وسيلة أخرى');
  });

  it('labels the cases the audit named', () => {
    expect(paymentStatusLabel('cod_pending', 'ar')).toBe('الدفع عند الاستلام');
    expect(paymentProviderLabel('instapay', 'ar')).toBe('إنستاباي');
    expect(paymentMethodLabel('PAYATFAWRY', 'en')).toBe('Pay at Fawry');
    expect(paymentMethodLabel('Credit-Card', 'en')).toBe('Credit card');
  });
});

describe('formatEstimatedDays', () => {
  it('is bilingual', () => {
    expect(formatEstimatedDays({ estimatedDaysMin: 2, estimatedDaysMax: 4 }, 'en')).toBe(
      '2–4 business days'
    );
    expect(formatEstimatedDays({ estimatedDaysMin: 2, estimatedDaysMax: 4 }, 'ar')).toBe(
      '2–4 أيام عمل'
    );
    expect(formatEstimatedDays({ estimatedDays: 1 }, 'ar')).toBe('يوم عمل واحد');
    expect(formatEstimatedDays({ estimatedDays: 1 }, 'en')).toBe('1 business day');
    expect(formatEstimatedDays({}, 'ar')).toMatch(/[؀-ۿ]/);
    expect(formatEstimatedDays({}, 'en')).toBe('Delivery time varies');
  });
});

import {
  returnPolicyCopy,
  returnPolicyKind,
  termsReturnSentence,
  faqReturnAnswer,
} from '../../apps/web/src/lib/return-policy-text';

describe('return policy text', () => {
  it('classifies the store value', () => {
    expect(returnPolicyKind(14)).toBe('window');
    expect(returnPolicyKind(0)).toBe('none');
    expect(returnPolicyKind(null)).toBe('undeclared');
    expect(returnPolicyKind(undefined)).toBe('undeclared');
  });

  it('prints the real window, never a stale 30', () => {
    for (const lang of ['en', 'ar'] as const) {
      const all = [
        returnPolicyCopy(14, lang).title,
        returnPolicyCopy(14, lang).body,
        termsReturnSentence(14, lang),
        faqReturnAnswer(14, lang),
      ].join(' ');
      expect(all).toContain('14');
      expect(all).not.toContain('30');
    }
  });

  it('says returns are not accepted at 0 and prints no number when undeclared', () => {
    expect(returnPolicyCopy(0, 'en').title).toBe('Returns Not Accepted');
    expect(returnPolicyCopy(0, 'ar').title).toBe('الإرجاع غير متاح');
    for (const lang of ['en', 'ar'] as const) {
      const text = [
        returnPolicyCopy(undefined, lang).body,
        termsReturnSentence(null, lang),
        faqReturnAnswer(undefined, lang),
      ].join(' ');
      expect(text).not.toMatch(/\d/);
    }
  });
});
