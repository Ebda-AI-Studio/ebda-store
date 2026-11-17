/**
 * Shapes of `GET /stores/:id/billing` -> `billing` (also embedded in
 * `GET /onboarding/state`). One definition so the onboarding steps, the
 * merchant billing page and the store-wide banner cannot drift.
 */

import type { InstapayReceiptView } from '@ebda/shared';

export type BillingInterval = 'monthly' | 'yearly';
export type TrialPlanCode = 'basic' | 'growth' | 'business';

export interface PlanSelection {
  planCode: TrialPlanCode;
  interval: BillingInterval;
}

export interface BillingCard {
  last4: string | null;
  brand: string | null;
  savedAt: string | null;
}

/** Ebda's own VAT inside an amount (present only when the "Ebda VAT" setting is ON). */
export interface PlatformVatLine {
  netMinor: number;
  vatMinor: number;
  rateBps: number;
  mode: 'inclusive' | 'exclusive';
  trn: string | null;
  legalName: string | null;
}

export interface BillingInfo {
  billingInterval: BillingInterval;
  /** Plan chosen at signup; billed when the trial ends. */
  pendingPlanCode: string | null;
  nextRetryAt: string | null;
  dunningAttempts: number;
  hasPaymentMethod: boolean;
  billedByPlatform: boolean;
  card: BillingCard | null;
  trialEndsAt: string | null;
  nextCharge: {
    at: string;
    planCode: string;
    amountMinor: number | null;
    vat?: PlatformVatLine | null;
  } | null;
  /** The card option is offered only when 'card_on_file'. */
  trialCardMode: 'card_on_file' | 'pay_at_trial_end' | null;
  /** false = BILLING_PROVIDER=none (InstaPay only): nothing is ever charged to a card (BILLING-NONE-COPY-1). */
  cardBilling?: boolean;
  billingMethod: 'card' | 'instapay' | null;
  instapay: {
    available: boolean;
    handle: string | null;
    reference: string | null;
    amountMinor: number | null;
    /** VAT inside `amountMinor`; null/absent = no VAT line. */
    vat?: PlatformVatLine | null;
    /** Ebda's InstaPay QR image; null/absent = no QR. */
    qrUrl?: string | null;
    pendingClaims: number;
  };
  dueSoon: { dueAt: string; daysLeft: number } | null;
  /** B2: the next payment is within the 7-day reminder window (or past). Absent = treat as inside (older API). */
  inRenewalWindow?: boolean;
  /** B2: what the current term rests on; null/absent = none. */
  termBasis?: 'paid' | 'assigned' | 'comped' | 'trial' | null;
  overdue: boolean;
  /** InstaPay: the store pauses at this time if unpaid. */
  suspendAt: string | null;
  /** wa.me link, or null when support WhatsApp is not configured. */
  supportWhatsappUrl: string | null;
  /** Ebda support email: shown whenever there is no WhatsApp link. */
  supportEmail?: string | null;
  suspension: { reason: 'unpaid' | 'over_store_limit'; at: string } | null;
}

export interface PaymentClaim {
  id: string;
  planCode: string;
  billingInterval: BillingInterval;
  amountMinor: number;
  method: string;
  paymentReference: string | null;
  /** Legacy typed reference; claims made with a receipt carry it in `receipt.fields.reference`. */
  payerReference?: string | null;
  status: 'pending' | 'confirmed' | 'rejected';
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
  receipt?: InstapayReceiptView | null;
}

/** Minimal plan row needed to show a price card. */
export interface PlanOption {
  code: string;
  nameEn: string;
  nameAr: string;
  priceMonthlyMinor: number | null;
  priceYearlyMinor: number | null;
}

export const SIGNUP_PLAN_KEY = 'ebda.signup.plan';

export function isTrialPlanCode(v: unknown): v is TrialPlanCode {
  return v === 'basic' || v === 'growth' || v === 'business';
}

/** The plan chosen on the marketing site / signup page, if one was persisted. */
export function readStoredPlan(): PlanSelection | null {
  try {
    const raw = window.localStorage.getItem(SIGNUP_PLAN_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PlanSelection>;
    if (isTrialPlanCode(v.planCode) && (v.interval === 'monthly' || v.interval === 'yearly')) {
      return { planCode: v.planCode, interval: v.interval };
    }
  } catch {
    // Storage can be blocked or hold junk; the plan step then just preselects the default.
  }
  return null;
}

export function storePlan(selection: PlanSelection): void {
  try {
    window.localStorage.setItem(SIGNUP_PLAN_KEY, JSON.stringify(selection));
  } catch {
    // Storage unavailable (private window): the choice still travels in component state.
  }
}
