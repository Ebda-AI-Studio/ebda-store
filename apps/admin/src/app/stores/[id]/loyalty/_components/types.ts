/**
 * Shared types and defaults for the loyalty page. Kept in _components so the
 * page.tsx and its subcomponents import from the same module, avoiding
 * duplicate type declarations.
 */

export interface LoyaltyTier {
  minPoints: number;
  multiplier: number;
}

export type TierKey = 'bronze' | 'silver' | 'gold' | 'platinum';

export interface LoyaltySettings {
  pointsPerMajorUnit: number;
  signupBonus: number;
  referralBonus: number;
  reviewBonus: number;
  birthdayBonus: number;
  tiers: Record<TierKey, LoyaltyTier>;
  pointsValue: number;
  minRedeemPoints: number;
  maxRedeemPercentage: number;
  expirationMonths: number;
}

export interface LoyaltyMember {
  id: string;
  customerId: string;
  points: number;
  totalEarned: number;
  totalRedeemed: number;
  tier: string;
  customer: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
}

export interface LoyaltyStats {
  totalMembers: number;
  tierBreakdown: Record<TierKey, number>;
  totalPointsIssued: number;
  totalPointsRedeemed: number;
  outstandingPoints: number;
}

export const TIER_COLORS: Record<string, { bg: string; text: string; icon: string }> = {
  bronze: { bg: 'bg-warning/10', text: 'text-warning-ink', icon: 'bg-warning' },
  silver: { bg: 'bg-muted', text: 'text-foreground', icon: 'bg-muted-foreground' },
  gold: { bg: 'bg-warning/10', text: 'text-warning-ink', icon: 'bg-warning' },
  platinum: { bg: 'bg-info/10', text: 'text-info-ink', icon: 'bg-info' },
};

export const TIER_KEYS: TierKey[] = ['bronze', 'silver', 'gold', 'platinum'];

export const DEFAULT_SETTINGS: LoyaltySettings = {
  pointsPerMajorUnit: 1,
  signupBonus: 100,
  referralBonus: 200,
  reviewBonus: 50,
  birthdayBonus: 500,
  tiers: {
    bronze: { minPoints: 0, multiplier: 1.0 },
    silver: { minPoints: 1000, multiplier: 1.25 },
    gold: { minPoints: 5000, multiplier: 1.5 },
    platinum: { minPoints: 15000, multiplier: 2.0 },
  },
  pointsValue: 1,
  minRedeemPoints: 500,
  maxRedeemPercentage: 50,
  expirationMonths: 12,
};
