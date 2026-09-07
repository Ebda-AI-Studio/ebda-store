/**
 * Pure helpers for the WhatsApp cart-token redemption on the checkout path.
 *
 * WaTokenHydrator was flagged at 23 branches in 92 lines, and it sits on the
 * checkout path: a silent failure here means a shopper who came from WhatsApp
 * arrives with an empty basket. Most of those branches were storage guards and
 * payload validation, both of which are pure and testable — unlike the effect.
 */

export interface WaCartItem {
  productId?: string;
  quantity?: number;
}

/** A bundle line on the WA cart token — see wa-bridge.routes.ts's `cartBundles`. */
export interface WaCartBundle {
  bundleId?: string;
  quantity?: number;
}

export interface WaCartPayload {
  items: WaCartItem[];
  /** Absent when the token carries no bundle lines (every pre-bundle token, and every token from a store without the `bundles` feature). */
  bundles?: WaCartBundle[];
  customerPhone?: string;
}

/**
 * sessionStorage access that cannot throw.
 *
 * Safari private mode throws on access rather than returning null, and this runs
 * before anything else on the page. A throw here would abort redemption entirely
 * — the shopper would lose the cart they built in WhatsApp because of a browser
 * privacy setting.
 */
export function sessionGet(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function sessionSet(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* private mode — the marker is an optimisation, not a correctness guard */
  }
}

/**
 * Validate a redeem response into a payload worth acting on.
 *
 * Returns null for anything unusable so the caller has one branch instead of
 * three. An empty items array is treated as nothing to do, not as an error:
 * a token can legitimately redeem to an empty cart — UNLESS it carries a
 * non-empty `bundles` array (a bundle-only WA order has zero loose items by
 * design), so `items` alone is no longer the sole "anything to do?" signal.
 */
export function parseWaCartPayload(json: unknown): WaCartPayload | null {
  const data = (json as { data?: WaCartPayload } | undefined)?.data;
  if (!data || !Array.isArray(data.items)) return null;
  const bundles = Array.isArray(data.bundles) ? data.bundles : undefined;
  if (data.items.length === 0 && (!bundles || bundles.length === 0)) return null;
  return { ...data, bundles };
}

/**
 * An item is redeemable only with a product id and a positive quantity.
 * Anything else cannot be added and would just produce a failed API call.
 */
export function isRedeemableItem(item: WaCartItem): boolean {
  return Boolean(item.productId) && typeof item.quantity === 'number' && item.quantity >= 1;
}

/** Same shape of check as `isRedeemableItem`, for a bundle line. */
export function isRedeemableBundle(bundle: WaCartBundle): boolean {
  return Boolean(bundle.bundleId) && typeof bundle.quantity === 'number' && bundle.quantity >= 1;
}

/**
 * Adds every redeemable bundle line via `addBundle` (production: a thin
 * wrapper over `api.addBundleToCart`, the exact client call
 * `BundleDetailClient`/`CartContext.addBundle` already use — see
 * `WaTokenHydrator.tsx`), one call per entry, sequentially (mirrors the
 * existing product loop: preserves order, avoids duplicate-detection
 * races on the server cart).
 *
 * Extracted as a pure function — same rationale as every other helper in
 * this file — so "a payload with bundles calls the add path once per
 * entry" is unit-testable without a DOM-rendering harness (none is
 * installed in this repo).
 *
 * Returns whether at least one bundle was added, matching the `anyAdded`
 * convention `WaTokenHydrator` already uses for products (only refetch the
 * cart when something actually changed). `onFailure` is called for a
 * redeemable line whose add was refused (e.g. it sold out between token
 * issue and redemption) — never for a line skipped as unredeemable, since
 * that never reached the server at all.
 */
export async function hydrateBundles(
  bundles: WaCartBundle[],
  addBundle: (bundleId: string, quantity: number) => Promise<{ success: boolean; error?: unknown }>,
  onFailure?: (bundleId: string, error: unknown) => void
): Promise<boolean> {
  let anyAdded = false;
  for (const bundle of bundles) {
    if (!isRedeemableBundle(bundle)) continue;
    const res = await addBundle(bundle.bundleId as string, bundle.quantity as number);
    if (res.success) {
      anyAdded = true;
    } else if (onFailure) {
      onFailure(bundle.bundleId as string, res.error);
    }
  }
  return anyAdded;
}

/** Strip the one-shot token so a refresh cannot re-redeem it. */
export function urlWithoutToken(href: string, param = 'waToken'): string {
  const url = new URL(href);
  url.searchParams.delete(param);
  return url.pathname + url.search;
}
