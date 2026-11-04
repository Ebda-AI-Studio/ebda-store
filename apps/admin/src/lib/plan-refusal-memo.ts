/**
 * P0 logout audit: the dashboard called a plan-gated insights endpoint on every load and got a 402 each time. The client
 * has no flag for the analytics TIER (only boolean features), so the first refusal is remembered for the session and the
 * call is not repeated. Per store and endpoint; sessionStorage, so a plan upgrade is picked up on the next session.
 */
const key = (endpoint: string, storeId: string) => `planRefused:${endpoint}:${storeId}`;

export function isRefusedThisSession(endpoint: string, storeId: string): boolean {
  try {
    return window.sessionStorage.getItem(key(endpoint, storeId)) === '1';
  } catch {
    return false;
  }
}

export function rememberRefusal(endpoint: string, storeId: string): void {
  try {
    window.sessionStorage.setItem(key(endpoint, storeId), '1');
  } catch {
    // storage blocked: the call simply repeats
  }
}
