import { describe, it, expect } from 'vitest';
import { isRenewalOnly } from '../../apps/admin/src/components/billing/notice';
import type { BillingInfo } from '../../apps/admin/src/components/billing/types';
import ar from '../../apps/admin/src/i18n/messages/ar.json';

const b = (over: Partial<BillingInfo> = {}) =>
  ({ dueSoon: null, overdue: false, suspension: null, ...over }) as BillingInfo;

describe('STORE-QA-24 InstaPay "due" copy only when a payment is actually due', () => {
  it('active plan far from renewal: renewal wording, no due block', () => {
    expect(isRenewalOnly('active', b(), false)).toBe(true);
    expect(isRenewalOnly('comped', b(), false)).toBe(true);
  });
  it('inside the renewal window, overdue, past due, suspended or a fresh quote: due block shows', () => {
    expect(isRenewalOnly('active', b({ dueSoon: { dueAt: 'x', daysLeft: 5 } }), false)).toBe(false);
    expect(isRenewalOnly('active', b({ overdue: true }), false)).toBe(false);
    expect(isRenewalOnly('past_due', b(), false)).toBe(false);
    expect(isRenewalOnly('active', b({ suspension: { reason: 'unpaid', at: 'x' } }), false)).toBe(
      false
    );
    expect(isRenewalOnly('active', b(), true)).toBe(false);
    expect(isRenewalOnly('trialing', b(), false)).toBe(false);
  });
  it('a dueSoon beyond the 7-day window is still renewal-only', () => {
    expect(isRenewalOnly('active', b({ dueSoon: { dueAt: 'x', daysLeft: 20 } }), false)).toBe(true);
  });
  it('the renewal copy exists and carries no returns-to-free threat', () => {
    expect(ar.billing.trial.renewalLine).toContain('التجديد الجاي');
    expect(ar.billing.trial.renewalLine).not.toContain('هترجع');
  });
});
