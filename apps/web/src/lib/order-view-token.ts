/**
 * SEC-15: the signed view token a GUEST order is created with. Kept in the buyer's own
 * sessionStorage (same tab survives the gateway redirect and back; gone when the tab closes), never
 * in the URL, so it cannot leak through history, referrers or a shared link. Every access is
 * try/catch: storage can be blocked, and the success page must still render (with a masked address).
 */
const KEY = (orderId: string) => `ebda:order-view-token:${orderId}`;

export function rememberOrderViewToken(orderId: string, token: unknown): void {
  if (typeof token !== 'string' || !token || typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(KEY(orderId), token);
  } catch {
    /* storage blocked: the order page falls back to the masked view */
  }
}

export function readOrderViewToken(orderId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(KEY(orderId));
  } catch {
    return null;
  }
}
