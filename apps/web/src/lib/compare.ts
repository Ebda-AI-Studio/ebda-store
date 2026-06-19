/**
 * localStorage key for the compare list, namespaced per store.
 *
 * Path-based stores (store.forcemediakw.com/<slug>) share a single localStorage
 * origin, so a flat 'compareProducts' key bled one store's compare list into a
 * sibling store. The active store id is set once by StoreContext (mirrors
 * `api.setStoreId`) and the key becomes `compareProducts:<storeId>`. Falls back
 * to the legacy flat key before a store has resolved.
 */
const LEGACY_COMPARE_KEY = 'compareProducts';
let currentStoreId: string | null = null;

/** Called by StoreContext when the active storefront store resolves. */
export function setCompareStoreId(storeId: string | null): void {
  currentStoreId = storeId && storeId !== 'demo' ? storeId : null;
}

/** The per-store compare list localStorage key. Exported for components that
 *  read/write the list directly (e.g. the Compare page). */
export function compareStorageKey(): string {
  return currentStoreId ? `${LEGACY_COMPARE_KEY}:${currentStoreId}` : LEGACY_COMPARE_KEY;
}

const MAX_COMPARE_ITEMS = 4;

export interface CompareProduct {
  id: string;
  name: string;
  slug: string;
  price: number;
  compareAtPrice?: number;
  images: string[];
  description?: string;
  specifications?: Record<string, string>;
}

/** Read the current compare list from localStorage. Returns [] on error or server. */
export function getCompareList(): CompareProduct[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(compareStorageKey());
    return raw ? (JSON.parse(raw) as CompareProduct[]) : [];
  } catch {
    return [];
  }
}

/** Persist the list back to localStorage. */
function saveCompareList(list: CompareProduct[]): void {
  try {
    localStorage.setItem(compareStorageKey(), JSON.stringify(list));
  } catch {
    // Storage quota exceeded – silently ignore
  }
}

/** Check whether a product id is already in the list. */
export function isInCompareList(productId: string): boolean {
  return getCompareList().some(p => p.id === productId);
}

/**
 * Add a product to the compare list.
 * @returns 'added' | 'already_added' | 'max_reached'
 */
export function addToCompare(product: CompareProduct): 'added' | 'already_added' | 'max_reached' {
  const list = getCompareList();
  if (list.some(p => p.id === product.id)) return 'already_added';
  if (list.length >= MAX_COMPARE_ITEMS) return 'max_reached';
  saveCompareList([...list, product]);
  return 'added';
}

/**
 * Remove a product from the compare list.
 * @returns true if it was in the list, false otherwise
 */
export function removeFromCompare(productId: string): boolean {
  const list = getCompareList();
  const next = list.filter(p => p.id !== productId);
  if (next.length === list.length) return false;
  saveCompareList(next);
  return true;
}

/**
 * Toggle compare state. Returns the new state ('added' | 'removed' | 'max_reached').
 */
export function toggleCompare(product: CompareProduct): 'added' | 'removed' | 'max_reached' {
  if (isInCompareList(product.id)) {
    removeFromCompare(product.id);
    return 'removed';
  }
  const result = addToCompare(product);
  if (result === 'max_reached') return 'max_reached';
  return 'added';
}
