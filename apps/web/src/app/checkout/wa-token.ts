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

export interface WaCartPayload {
  items: WaCartItem[];
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
 * a token can legitimately redeem to an empty cart.
 */
export function parseWaCartPayload(json: unknown): WaCartPayload | null {
  const data = (json as { data?: WaCartPayload } | undefined)?.data;
  if (!data || !Array.isArray(data.items) || data.items.length === 0) return null;
  return data;
}

/**
 * An item is redeemable only with a product id and a positive quantity.
 * Anything else cannot be added and would just produce a failed API call.
 */
export function isRedeemableItem(item: WaCartItem): boolean {
  return Boolean(item.productId) && typeof item.quantity === 'number' && item.quantity >= 1;
}

/** Strip the one-shot token so a refresh cannot re-redeem it. */
export function urlWithoutToken(href: string, param = 'waToken'): string {
  const url = new URL(href);
  url.searchParams.delete(param);
  return url.pathname + url.search;
}
