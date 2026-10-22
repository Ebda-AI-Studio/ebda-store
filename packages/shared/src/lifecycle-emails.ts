import { BRAND_MARKETING_URL } from './brand';

/**
 * Self-serve lifecycle emails (growth strategy 2026-10-22 section 3.4): the setup nudges, the trial
 * recap and the first-order referral ask. One definition shared by the API (schedule, idempotency,
 * copy) and the admin (the "emails we sent you" page), so a kind can never exist in one and not the
 * other.
 *
 * Email 6 of the strategy ("day 13, no card") is deliberately NOT a kind: the daily billing reminders
 * (`billing_reminders`: d7, d3, d1, d0) already email every trialing store 3, 1 and 0 days before it
 * ends, "needs a card" included. A second email on the same day would be a duplicate (Ruling LIFE-1).
 */
export const LIFECYCLE_EMAIL_KINDS = [
  'add_products',
  'payment_shipping',
  'test_order',
  'share_link',
  'trial_recap',
  'first_order',
] as const;
export type LifecycleEmailKind = (typeof LIFECYCLE_EMAIL_KINDS)[number];

/** The merchant's unsubscribe, stored as a row in the same table (unique per store). */
export const LIFECYCLE_OPTOUT_KIND = 'optout';
export const LIFECYCLE_STATUSES = ['sent', 'skipped', 'failed'] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export function isLifecycleKind(v: unknown): v is LifecycleEmailKind {
  return typeof v === 'string' && (LIFECYCLE_EMAIL_KINDS as readonly string[]).includes(v);
}

/** Days after the store was created at which each time-based nudge is due. */
export const LIFECYCLE_DELAY_DAYS = {
  add_products: 1,
  payment_shipping: 3,
  test_order: 5,
  share_link: 7,
} as const satisfies Partial<Record<LifecycleEmailKind, number>>;

/** The trial recap goes out this many days before the trial ends (the daily reminders start at 3). */
export const TRIAL_RECAP_DAYS_BEFORE_END = 4;

/** UTM values of the two referral surfaces, so the marketing site's first-touch capture can tell them apart. */
export const REFERRAL_UTM = {
  badge: { source: 'ebda_store_badge', medium: 'referral', campaign: 'powered_by' },
  email: { source: 'merchant_email', medium: 'email', campaign: 'first_order_referral' },
} as const;
export type ReferralSurface = keyof typeof REFERRAL_UTM;

/**
 * The marketing-site link for a referral surface. `content` is the referring store's host or slug (public
 * on its own storefront), so a signup can be traced back to the store that sent it.
 */
export function referralUrl(surface: ReferralSurface, content?: string): string {
  const u = REFERRAL_UTM[surface];
  const q = new URLSearchParams({
    utm_source: u.source,
    utm_medium: u.medium,
    utm_campaign: u.campaign,
  });
  const c = content?.trim().slice(0, 100);
  if (c) q.set('utm_content', c);
  return `${BRAND_MARKETING_URL}/?${q.toString()}`;
}
