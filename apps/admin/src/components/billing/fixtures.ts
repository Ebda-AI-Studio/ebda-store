import type { BillingInfo } from './types';

/** Test fixture: a trialing store with nothing set up yet. Override per test. */
export function billingFixture(over: Partial<BillingInfo> = {}): BillingInfo {
  return {
    billingInterval: 'monthly',
    pendingPlanCode: 'growth',
    nextRetryAt: null,
    dunningAttempts: 0,
    hasPaymentMethod: false,
    billedByPlatform: true,
    card: null,
    trialEndsAt: '2026-11-20T00:00:00.000Z',
    nextCharge: { at: '2026-11-20T00:00:00.000Z', planCode: 'growth', amountMinor: 349000 },
    trialCardMode: 'card_on_file',
    billingMethod: null,
    instapay: {
      available: false,
      handle: null,
      reference: null,
      amountMinor: null,
      pendingClaims: 0,
    },
    dueSoon: null,
    overdue: false,
    suspendAt: null,
    supportWhatsappUrl: null,
    supportEmail: 'ahlan@ebda.app',
    suspension: null,
    ...over,
  };
}
