/**
 * QA-88: the plan chip said "active" next to a payment that was still due, so a merchant could not tell trial from
 * paid from owing. The chip now shows one of: trial, active (paid), awaiting payment, past due, canceled, comped.
 */
export type SubscriptionStatus =
  | 'none'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'comped';

/**
 * `awaitingPayment` = the store has a payment due (an InstaPay transfer or a scheduled charge with nothing paid yet) and
 * the plan is not yet past due. A trial with a charge scheduled at its end stays a trial (nothing is due yet). The server status alone ("active") is true but misleading in that window.
 */
export function billingDisplayStatus(
  status: SubscriptionStatus,
  awaitingPayment: boolean
): SubscriptionStatus | 'awaiting_payment' {
  if (awaitingPayment && (status === 'active' || status === 'none')) return 'awaiting_payment';
  return status;
}

/** Whole days left in a trial (rounded up), or null when it has no end or already ended. */
export function trialDaysLeft(
  trialEndsAt: string | null | undefined,
  now = Date.now()
): number | null {
  if (!trialEndsAt) return null;
  const end = Date.parse(trialEndsAt);
  if (!Number.isFinite(end) || end <= now) return null;
  return Math.ceil((end - now) / 86_400_000);
}

/**
 * The "Renews on" / "Ends on" row. `currentPeriodEnd` is the period a subscription row was created with; it is only a
 * renewal date once the plan is actually paid or trialing/comped. While payment is awaited (or the plan is none or
 * canceled) it would promise a renewal that has not been bought (Amelia QA 2026-11-23: "renews 12 Nov 2027" on an unpaid
 * plan). A scheduled cancel still shows its end date.
 */
export function showPeriodEnd(
  displayStatus: SubscriptionStatus | 'awaiting_payment',
  cancelAtPeriodEnd: boolean
): boolean {
  if (cancelAtPeriodEnd) return displayStatus === 'active' || displayStatus === 'past_due';
  return displayStatus === 'active' || displayStatus === 'trialing' || displayStatus === 'comped';
}
