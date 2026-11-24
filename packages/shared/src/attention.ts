/**
 * "Needs attention" contract (merchant admin). One server aggregate per store
 * (`GET /stores/:id/attention`), consumed by the sidebar badge, the per-section badges, the Settings
 * overview list, the notification bell and the dashboard tiles: there is exactly one place that decides
 * what is wrong with a store.
 *
 * `section` is the page under /stores/[id] the fix lives on, the same value as
 * `SettingsGroupItem.path` in the admin, so a badge can be matched to its settings card.
 */
const ATTENTION_SEVERITIES = ['action', 'info'] as const;
type AttentionSeverity = (typeof ATTENTION_SEVERITIES)[number];

const ATTENTION_IDS = [
  'domain_unverified',
  'email_dns_missing',
  'gateway_connection_failed',
  'gateway_untested',
  'instapay_incomplete',
  'no_delivery_rates',
  'billing_past_due',
  'billing_claim_pending',
  'orders_over_limit',
  'tax_not_verified',
  'tax_review_pending',
  'chat_not_connected',
  'staff_invites_pending',
  'instapay_orders_unconfirmed',
  'payments_failed',
] as const;
type AttentionId = (typeof ATTENTION_IDS)[number];

export interface AttentionItem {
  id: AttentionId;
  severity: AttentionSeverity;
  /** Page under /stores/[id] that fixes it (e.g. `domain`, `payment-settings`). */
  section: string;
  title: { en: string; ar: string };
  message: { en: string; ar: string };
  /** Present for counted signals (pending invites, ...). */
  count?: number;
}

export interface AttentionResponse {
  items: AttentionItem[];
  /** Number of `action` items: what the sidebar dot shows. */
  actionCount: number;
}

export function countActionItems(items: readonly AttentionItem[]): number {
  return items.filter(i => i.severity === 'action').length;
}

/** Action-needed items per section, for the per-card badges. */
export function actionCountsBySection(items: readonly AttentionItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) if (i.severity === 'action') out[i.section] = (out[i.section] ?? 0) + 1;
  return out;
}

/** Sections that belong to the Sales hub / Orders tab rather than Settings. */
const ORDER_SECTIONS = new Set(['orders']);

/**
 * Badge numbers for the navigation, from the same feed: `orders` = how many orders need the merchant
 * (summed counts of order-money items), `settings` = how many settings issues need action. Info items
 * never badge. Used by the desktop sidebar (Sales / Settings) and the phone bottom bar (Orders / More).
 */
export function attentionNavBadges(items: readonly AttentionItem[]): {
  orders: number;
  settings: number;
} {
  let orders = 0;
  let settings = 0;
  for (const i of items) {
    if (i.severity !== 'action') continue;
    if (ORDER_SECTIONS.has(i.section)) orders += i.count ?? 1;
    else settings += 1;
  }
  return { orders, settings };
}
