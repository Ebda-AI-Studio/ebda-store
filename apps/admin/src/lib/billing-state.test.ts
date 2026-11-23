import { describe, expect, it } from 'vitest';
import { billingDisplayStatus, showPeriodEnd, trialDaysLeft } from './billing-state';

describe('billingDisplayStatus (QA-88)', () => {
  it('"active" with a payment due reads as awaiting payment, not active', () => {
    expect(billingDisplayStatus('active', true)).toBe('awaiting_payment');
    expect(billingDisplayStatus('none', true)).toBe('awaiting_payment');
    expect(billingDisplayStatus('trialing', true)).toBe('trialing'); // charge at trial end, nothing due yet
  });
  it('paid active, trial and the hard states are unchanged', () => {
    expect(billingDisplayStatus('active', false)).toBe('active');
    expect(billingDisplayStatus('trialing', false)).toBe('trialing');
    expect(billingDisplayStatus('past_due', true)).toBe('past_due');
    expect(billingDisplayStatus('comped', true)).toBe('comped');
    expect(billingDisplayStatus('canceled', true)).toBe('canceled');
  });
});

describe('trialDaysLeft', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  it('rounds up whole days, null when ended or absent', () => {
    expect(trialDaysLeft('2026-11-23T11:00:00Z', now)).toBe(3);
    expect(trialDaysLeft('2026-11-19T00:00:00Z', now)).toBeNull();
    expect(trialDaysLeft(null, now)).toBeNull();
  });
});

describe('showPeriodEnd', () => {
  it('no renewal date while payment is awaited, none or canceled', () => {
    expect(showPeriodEnd('awaiting_payment', false)).toBe(false);
    expect(showPeriodEnd('none', false)).toBe(false);
    expect(showPeriodEnd('canceled', false)).toBe(false);
    expect(showPeriodEnd('awaiting_payment', true)).toBe(false);
  });
  it('shows it for a paid, trialing or comped plan, and the end date of a scheduled cancel', () => {
    expect(showPeriodEnd('active', false)).toBe(true);
    expect(showPeriodEnd('trialing', false)).toBe(true);
    expect(showPeriodEnd('comped', false)).toBe(true);
    expect(showPeriodEnd('active', true)).toBe(true);
  });
});
