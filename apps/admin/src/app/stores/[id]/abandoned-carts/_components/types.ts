export interface AbandonedCartStats {
  totalAbandoned: number;
  /** `null` = not tracked (issue 2035): nothing attributes an order to a reminder. */
  totalRecovered: number | null;
  recoveryRate: number | null;
  recoveredRevenue: number | null;
}

export interface AbandonedCartConfig {
  step1Enabled: boolean;
  step1DelayMinutes: number;
  step2Enabled: boolean;
  step2DelayMinutes: number;
  step3Enabled: boolean;
  step3DelayMinutes: number;
  autoCouponEnabled: boolean;
  couponDiscountPercent: number;
  couponMaxDiscount: number | null;
  couponExpiryHours: number;
  emailEnabled: boolean;
  emailDelayMinutes: number;
}

export interface AbandonedCartRecord {
  id: string;
  createdAt: string;
  status: string;
  customerEmail: string | null;
  customerPhone: string | null;
  /** Recovery email state: null = not claimed; queued | sent | skipped | failed. */
  emailStatus: string | null;
  emailDetail: string | null;
  cartTotal: number;
  cartItemCount: number;
  customer: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
  } | null;
}

export interface ListMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export const DEFAULT_CONFIG: AbandonedCartConfig = {
  step1Enabled: true,
  step1DelayMinutes: 60,
  step2Enabled: true,
  step2DelayMinutes: 240,
  step3Enabled: true,
  step3DelayMinutes: 1440,
  autoCouponEnabled: true,
  couponDiscountPercent: 10,
  couponMaxDiscount: null,
  couponExpiryHours: 48,
  emailEnabled: false,
  emailDelayMinutes: 120,
};

export const CART_STATUS_KEYS = [
  'pending',
  'step1_sent',
  'step2_sent',
  'step3_sent',
  'recovered',
  'expired',
] as const;

export type CartStatus = (typeof CART_STATUS_KEYS)[number];
