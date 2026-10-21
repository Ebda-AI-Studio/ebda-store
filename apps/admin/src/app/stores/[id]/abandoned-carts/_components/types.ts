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

/**
 * Color palette for the abandoned-cart status pill. Handed to the shared
 * OrderStatusBadge via `colorMap`. The step-sent statuses are informational
 * (not order-lifecycle steps) so they use the `info` token rather than the
 * warning/success palette used elsewhere.
 */
export const ABANDONED_CART_COLORS = {
  pending: { className: 'bg-warning/10 text-warning-ink dark:bg-warning/30 dark:text-warning-ink' },
  step1_sent: { className: 'bg-info/10 text-info-ink dark:bg-info/30 dark:text-info-ink' },
  step2_sent: { className: 'bg-info/10 text-info-ink dark:bg-info/30 dark:text-info-ink' },
  step3_sent: { className: 'bg-info/10 text-info-ink dark:bg-info/30 dark:text-info-ink' },
  recovered: {
    className: 'bg-success/10 text-success-ink dark:bg-success/30 dark:text-success-ink',
  },
  expired: { className: 'bg-muted text-muted-foreground' },
} as const;
