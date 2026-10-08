import { describe, expect, it } from 'vitest';
import { subscriptionRequiredCopy } from './checkoutErrors';

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
