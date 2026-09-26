/**
 * `store.settings` redaction for the public storefront payload.
 *
 * `settings` is a merchant-editable JSON bag with an open write schema
 * (`z.record(z.string(), z.any())` in store.routes.ts) — an admin picker can
 * write any key. `public.routes.ts` (GET /stores, /stores/:slugOrId, /store)
 * used to return it verbatim (`settings: true` in the Prisma select, no
 * projection on the way out), which shipped `orderInvoiceEmail` — the
 * merchant owner's own inbox address, order-notification PII — to every
 * storefront visitor.
 *
 * Fixed with an ALLOWLIST rather than a denylist naming `orderInvoiceEmail`:
 * a denylist only ever knows about the sensitive key someone already found.
 * The keys below are every `store.settings.*` / `store?.settings?.*` read in
 * apps/web + apps/orders as of 2026-09-25 (ShopChrome's nav/footer/utility
 * bar/contact/floating-widget, checkout's label/delivery-windows/minimum
 * order, and the storefront-wide `defaultLanguage` that sets `<html lang>` —
 * dropping any of these would break every one of the 3 live stores'
 * storefront chrome or checkout, not just an edge case). A future storefront
 * feature that reads a NEW settings key must add it here — the same
 * allowlist-not-guess trade `EFFECTIVE_STOCK_SELECT` and the CSP directive
 * floor already make elsewhere in this repo.
 */
const PUBLIC_SETTINGS_KEYS = [
  'defaultLanguage',
  'navMenu',
  'footerLinks',
  'utilityBar',
  'contact',
  'floatingWidget',
  'checkoutLabel',
  'checkoutLabelAr',
  'checkoutDelivery',
  'minimumOrderFils',
] as const;

/**
 * Project `settings` down to the public allowlist. Returns `{}` for
 * null/non-object input so callers can spread the result unconditionally.
 */
export function publicStoreSettings(settings: unknown): Record<string, unknown> {
  if (!settings || typeof settings !== 'object') return {};
  const src = settings as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_SETTINGS_KEYS) {
    if (key in src) out[key] = src[key];
  }
  return out;
}
