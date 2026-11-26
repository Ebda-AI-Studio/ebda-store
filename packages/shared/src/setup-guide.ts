/**
 * Dashboard setup-guide checklist (SP5 self-serve onboarding).
 *
 * One definition shared by the API (which computes `done` from real data) and
 * the admin (which renders it), so the keys can never drift.
 *
 * `auto` items are derived ONLY from store data and cannot be ticked by hand.
 * `manual` items have no reliable data signal (the merchant confirms them, or
 * a flow marks them); `optional` items do not count toward "required" progress.
 */
export const SETUP_GUIDE_KEYS = [
  'add_product',
  'brand',
  'shipping',
  'payment',
  'domain',
  'test_order',
  'share',
] as const;

export type SetupGuideKey = (typeof SETUP_GUIDE_KEYS)[number];

export interface SetupGuideItemDef {
  key: SetupGuideKey;
  /** Completed by real data (product count, zones, orders, ...). */
  auto: boolean;
  /** A merchant (or a flow) may mark it done by hand. */
  manual: boolean;
  optional: boolean;
  /** Admin route under `/stores/:id/`. */
  href: string;
}

export const SETUP_GUIDE_ITEMS: readonly SetupGuideItemDef[] = [
  { key: 'add_product', auto: true, manual: false, optional: false, href: 'products' },
  { key: 'brand', auto: true, manual: false, optional: false, href: 'branding' },
  { key: 'shipping', auto: true, manual: false, optional: false, href: 'shipping' },
  { key: 'payment', auto: true, manual: true, optional: false, href: 'payment-settings' },
  { key: 'domain', auto: true, manual: true, optional: true, href: 'domain' },
  { key: 'test_order', auto: true, manual: false, optional: false, href: 'orders' },
  { key: 'share', auto: false, manual: true, optional: false, href: '' },
];

export interface SetupGuideItemState {
  key: SetupGuideKey;
  done: boolean;
  /** True when `done` came from store data rather than a manual tick. */
  fromData: boolean;
  optional: boolean;
  manual: boolean;
}

export interface SetupGuideState {
  items: SetupGuideItemState[];
  doneCount: number;
  totalCount: number;
  /** Required items only. */
  requiredDone: number;
  requiredTotal: number;
  dismissed: boolean;
  /** Orders whose payment is `paid` (the launch chip's "first 5 paid orders" goal). Absent on an older API. */
  paidOrders?: number;
}

/** Salla-style launch goal: the top-bar chip stays until the store has this many paid orders. */
export const FIRST_PAID_ORDERS_GOAL = 5;

export function isSetupGuideKey(v: unknown): v is SetupGuideKey {
  return typeof v === 'string' && (SETUP_GUIDE_KEYS as readonly string[]).includes(v);
}
