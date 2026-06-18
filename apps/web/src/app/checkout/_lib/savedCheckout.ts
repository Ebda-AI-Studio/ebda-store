/**
 * Device-local, store-scoped checkout info persistence.
 *
 * Stores contact + address fields ONLY in localStorage under a per-store key.
 * NEVER stores payment data, tokens, session identifiers, or card details.
 *
 * Key format: `force:checkout:<storeId>`
 */

export interface SavedCheckout {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  governorate: string;
  governorateAr: string;
  area: string;
  areaAr: string;
  block: string;
  street: string;
  avenue: string;
  house: string;
  floor: string;
  apartment: string;
  notes: string;
}

function storageKey(storeId: string): string {
  return `force:checkout:${storeId}`;
}

/**
 * Persist contact + address info to localStorage for the given store.
 * No-ops in SSR (typeof window === 'undefined').
 */
export function saveCheckoutInfo(storeId: string, data: SavedCheckout): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(storeId), JSON.stringify(data));
  } catch {
    // Quota exceeded or storage disabled — not fatal.
  }
}

/**
 * Load previously saved contact + address info for the given store.
 * Returns null if nothing is stored, the entry is corrupt, or we're in SSR.
 */
export function loadCheckoutInfo(storeId: string): SavedCheckout | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey(storeId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as SavedCheckout;
  } catch {
    return null;
  }
}

/**
 * Remove any saved checkout info for the given store from localStorage.
 */
export function clearCheckoutInfo(storeId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(storageKey(storeId));
  } catch {
    // Non-fatal.
  }
}
