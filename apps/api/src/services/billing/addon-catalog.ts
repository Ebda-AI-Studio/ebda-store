/**
 * What a merchant can buy outside the plan (SELF-SERVICE A8 + A9). One catalog, integer piastres.
 *
 * Ruling ADDON-1 - prices are placeholders pending Ahmad's number: EGP 99 per add-on per 30 days, AI packs EGP 49 / 149.
 * Change them HERE only (the preview, the ledger row and the screen all read this file). Cost if wrong: a merchant is
 * quoted and charged the wrong amount; the quote is shown and confirmed before any charge, so the damage is bounded
 * to one wrong-price purchase that can be refunded from the ledger.
 *
 * A purchase is a `billing_events` row of type `upgrade` whose `planCode` is `addon:<sku>`. Ruling ADDON-2 - no new
 * type or table: the type CHECK exists in Postgres AND in the D1 platform schema and a new store-scoped table touches
 * the D1 split, erasure and tenant-guard snapshots. The prefix keeps every plan reader safe: `plans` has no such code,
 * so each of them fails closed on it.
 */
import type { FeatureKey } from '@ebda/shared';

export const ADDON_TERM_DAYS = 30;
export const ADDON_PLAN_PREFIX = 'addon:';
/** Append-only renewal intent rows (ADDON-RENEW-1): zero-amount `upgrade` rows that never start with `addon:`. */
export const ADDON_CANCEL_PREFIX = 'addon-cancel:';
export const ADDON_RESUME_PREFIX = 'addon-resume:';
export const ADDON_MARKER_PREFIX = 'addon-';

type AddonKind = 'feature' | 'ai_topup';
export interface AddonItem {
  sku: string;
  kind: AddonKind;
  featureKey?: FeatureKey;
  /** Extra AI requests per day for the term (ai_topup only). */
  aiExtraRequests?: number;
  priceMinor: number;
  nameEn: string;
  nameAr: string;
}

const FEATURE_PRICE_MINOR = 9900;
const feature = (key: FeatureKey, nameEn: string, nameAr: string): AddonItem => ({
  sku: `feature:${key}`,
  kind: 'feature',
  featureKey: key,
  priceMinor: FEATURE_PRICE_MINOR,
  nameEn,
  nameAr,
});

const ITEMS: AddonItem[] = [
  feature('floating_widget', 'Floating Widget', 'الزر العائم'),
  feature('customer_wallet_checkout', 'Pay with Wallet at Checkout', 'الدفع من المحفظة عند الشراء'),
  feature('loyalty', 'Loyalty Program', 'برنامج الولاء'),
  feature('upsell_crosssell', 'Upsell & Cross-sell', 'البيع الإضافي'),
  feature('push_notifications', 'Push Notifications', 'الإشعارات'),
  feature('affiliate', 'Affiliate Program', 'برنامج التسويق بالعمولة'),
  {
    sku: 'ai:topup_300',
    kind: 'ai_topup',
    aiExtraRequests: 300,
    priceMinor: 4900,
    nameEn: '+300 AI requests a day',
    nameAr: '300 طلب ذكاء اصطناعي زيادة كل يوم',
  },
  {
    sku: 'ai:topup_1000',
    kind: 'ai_topup',
    aiExtraRequests: 1000,
    priceMinor: 14900,
    nameEn: '+1000 AI requests a day',
    nameAr: '1000 طلب ذكاء اصطناعي زيادة كل يوم',
  },
];

export const ADDON_CATALOG: Record<string, AddonItem> = Object.fromEntries(
  ITEMS.map(i => [i.sku, i])
);

/** Feature add-ons renew every term on the saved card; AI packs never do. */
export const renewsEachTerm = (item: AddonItem): boolean => item.kind === 'feature';

export const planCodeOfSku = (sku: string): string => `${ADDON_PLAN_PREFIX}${sku}`;

/** The catalog sku a ledger `planCode` names, or null (a real plan, or an add-on that is no longer sold). */
export function skuOfPlanCode(planCode: string | null | undefined): string | null {
  if (!planCode?.startsWith(ADDON_PLAN_PREFIX)) return null;
  const sku = planCode.slice(ADDON_PLAN_PREFIX.length);
  return ADDON_CATALOG[sku] ? sku : null;
}
