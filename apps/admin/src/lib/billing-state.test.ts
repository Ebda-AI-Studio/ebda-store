import { describe, expect, it } from 'vitest';
import { billingDisplayStatus, trialDaysLeft } from './billing-state';

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
