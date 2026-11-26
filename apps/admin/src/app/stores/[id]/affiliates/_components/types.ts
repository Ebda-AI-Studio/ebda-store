export interface AffiliateConfig {
  defaultCommissionRate: number;
  cookieDurationDays: number;
  minPayoutAmount: number;
  autoApprove: boolean;
  publicSignupEnabled: boolean;
}

export interface AffiliateStats {
  totalAffiliates: number;
  activeAffiliates: number;
  totalReferrals: number;
  conversions: number;
  conversionRate: number;
  commissionPaid: number;
}

export interface Affiliate {
  id: string;
  name: string;
  email: string;
  referralCode: string;
  status: string;
  totalEarned: number;
  pendingBalance: number;
  totalPaid: number;
  commissionRate: number | null;
  instagram: string | null;
  tiktok: string | null;
  notes: string | null;
  createdAt: string;
  _count: { referrals: number; payouts: number };
}

export interface Meta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export type AffiliateStatusAction = 'approve' | 'reject' | 'suspend';

export const STATUS_FILTERS = ['all', 'pending', 'approved', 'rejected', 'suspended'] as const;

export const DEFAULT_CONFIG: AffiliateConfig = {
  defaultCommissionRate: 10,
  cookieDurationDays: 30,
  minPayoutAmount: 5000,
  autoApprove: false,
  publicSignupEnabled: true,
};

export { formatPrice as formatFils } from '@/lib/format';
