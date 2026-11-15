/**
 * The merchant-facing state of one add-on, DERIVED from the ledger (Ruling ADDON-SS-2: nothing new is stored).
 * Pure, so every state has a test that fails when the rule is broken.
 *
 * Precedence for a SKU: a running paid term > a super-admin grant / the plan > the newest ledger attempt.
 * A pending attempt only counts while it is fresh (a checkout the merchant abandoned must not block Buy forever).
 */
export type AddonState =
  | 'available'
  | 'pending_payment'
  | 'failed'
  | 'active'
  | 'renewing'
  | 'cancelled_at_period_end'
  | 'expired'
  | 'refunded'
  | 'included'
  | 'granted';

const PENDING_FRESH_MS = 30 * 60_000;
const FAILED_VISIBLE_MS = 7 * 86_400_000;
const ENDED_VISIBLE_MS = 30 * 86_400_000;

export interface AttemptRow {
  status: string;
  createdAt: Date;
  forPeriodEnd: Date | null;
}

interface StateInput {
  /** The feature SKUs renew each term; AI packs never do. */
  renews: boolean;
  isFeature: boolean;
  running: { endsAt: Date; cancelAtPeriodEnd: boolean } | null;
  /** Feature is on WITHOUT any paid add-on: via the plan baseline or a super-admin override. */
  onWithoutAddon: boolean;
  /** A super-admin override row turned it on (so the cause is a grant, not the plan). */
  overrideOn: boolean;
  /** Newest ledger row for this SKU (`addon:<sku>`), or null. */
  newest: AttemptRow | null;
  now: Date;
}

export function deriveAddonState(i: StateInput): AddonState {
  if (i.running) {
    if (i.running.cancelAtPeriodEnd) return 'cancelled_at_period_end';
    return i.renews ? 'renewing' : 'active';
  }
  if (i.isFeature && i.onWithoutAddon) return i.overrideOn ? 'granted' : 'included';
  const n = i.newest;
  if (!n) return 'available';
  const age = i.now.getTime() - n.createdAt.getTime();
  if (n.status === 'pending') return age < PENDING_FRESH_MS ? 'pending_payment' : 'available';
  if (n.status === 'failed') return age < FAILED_VISIBLE_MS ? 'failed' : 'available';
  if (n.status === 'refunded') return age < ENDED_VISIBLE_MS ? 'refunded' : 'available';
  if (n.status === 'succeeded' && n.forPeriodEnd && n.forPeriodEnd.getTime() <= i.now.getTime()) {
    return i.now.getTime() - n.forPeriodEnd.getTime() < ENDED_VISIBLE_MS ? 'expired' : 'available';
  }
  return 'available';
}
