/**
 * Monthly price of ONE feature bought on top of a lower plan, in integer piastres, net of Ebda's platform VAT (the quote
 * adds it). THE single source: the catalogue, the quote, the gate line ("add just this feature for EGP X a month") and the
 * Add-ons page all read it. Approved by Ahmad 2026-11-15 (register: "Feature price proposal (lower plans)").
 *
 * A feature that became sellable later (Business now holds every feature) and has no approved price yet falls back to the
 * placeholder below until a price is approved; never guess a final price here.
 */
import type { FeatureKey } from './features';

// pq-allow(unused-export): the price tests assert unpriced features keep this placeholder
export const ADDON_PLACEHOLDER_PRICE_MINOR = 9900;

const egp = (n: number) => n * 100;

// pq-allow(unused-export): the price tests read the approved table directly, so a stale price cannot hide
export const ADDON_FEATURE_PRICE_MINOR: Partial<Record<FeatureKey, number>> = {
  loyalty: egp(249),
  customer_wallet: egp(99),
  customer_wallet_checkout: egp(99),
  push_notifications: egp(149),
  email_campaigns: egp(199),
  affiliate: egp(299),
  floating_widget: egp(79),
  'inventory.stock_alerts': egp(79),
  'inventory.backorder': egp(99),
  'inventory.multi_warehouse': egp(349),
  'inventory.barcode': egp(199),
  'inventory.purchase_orders': egp(249),
  'inventory.bulk_adjustments': egp(129),
  'accounting.basic': egp(149),
  'accounting.expenses': egp(99),
  'accounting.invoicing': egp(199),
  'accounting.tax_reports': egp(199),
  'accounting.multi_currency': egp(149),
  'accounting.bank_reconcile': egp(299),
  payment_abandonment: egp(149),
  // Approved 2026-11-15 for the features Business-all-features makes sellable to lower plans. b2b.wholesale is hidden until
  // it ships, so it is sold only then (the sellable set excludes hidden features).
  bundles: egp(149),
  remove_branding: egp(249),
  customer_intelligence: egp(149),
  merchant_mcp: egp(199),
  merchant_mcp_write: egp(99),
  'b2b.wholesale': egp(399),
};

export function addonFeaturePriceMinor(key: FeatureKey): number {
  return ADDON_FEATURE_PRICE_MINOR[key] ?? ADDON_PLACEHOLDER_PRICE_MINOR;
}
