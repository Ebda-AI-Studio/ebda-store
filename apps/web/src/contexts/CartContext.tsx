'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useToast } from '@force/ui';
import { api } from '@/lib/api';
import { classifyBundleCartError, bundleCartErrorCopy } from '@/lib/bundle-cart-errors';
import { useLanguage } from './LanguageContext';
import { useStore } from './StoreContext';

import { readLocalCart, toSyncPayload } from './cart-hydration';

export interface CartItem {
  // Server cart_item row id once the item is synced. Before the first
  // server round-trip (e.g. on an offline add) this holds the productId
  // so optimistic UI still has a stable key.
  id: string;
  productId: string;
  name: string;
  nameAr?: string;
  price: number;
  quantity: number;
  image?: string;
  slug: string;
  category?: string;
  variantId?: string;
  /** Resolved variant label (e.g. "Red / Large") for display on the cart page. */
  variantTitle?: string;
  variantTitleAr?: string;
}

// Shape returned by GET /public/cart
interface ServerCartItem {
  id: string;
  productId: string;
  quantity: number;
  variantId?: string | null;
  product: {
    id: string;
    name: string;
    nameAr?: string | null;
    slug: string;
    price: number;
    images?: Array<{ id: string; url: string; alt?: string | null }>;
    categories?: Array<{ category: { name?: string; nameAr?: string } }>;
  };
  variant?: { id: string; title: string; titleAr?: string | null; price?: number } | null;
}

/**
 * A bundle line in the cart — the box the customer bought, priced and
 * displayed as ONE row (see `CartBundleView` on the API). Never expose the
 * per-component allocated shares to the customer; those exist only for
 * admin/picking/accounting. `id` is the `CartBundle` row id (what
 * `DELETE /public/cart/bundles/:cartBundleId` takes), distinct from
 * `bundleId` (the catalog `Bundle` id) — same distinction as `CartItem.id`
 * vs `.productId`.
 */
export interface CartBundle {
  id: string;
  bundleId: string;
  name: string;
  nameAr?: string;
  image?: string;
  quantity: number;
  unitPrice: number;
  total: number;
  available: number;
}

// Shape returned by GET /public/cart's `bundles` array (CartBundleView).
interface ServerCartBundle {
  id: string;
  bundleId: string;
  name: string;
  nameAr: string | null;
  image: string | null;
  quantity: number;
  unitPrice: number;
  total: number;
  available: number;
}

interface CartContextType {
  items: CartItem[];
  bundles: CartBundle[];
  isReady: boolean;
  addItem: (item: Omit<CartItem, 'quantity' | 'productId'>, quantity?: number) => Promise<boolean>;
  removeItem: (id: string) => Promise<void>;
  updateQuantity: (id: string, quantity: number) => Promise<void>;
  /** Add a bundle to the cart as its own row (never expanded into items). */
  addBundle: (bundleId: string, quantity?: number) => Promise<boolean>;
  /** Remove one bundle line — `id` is the CartBundle row id, not bundleId. */
  removeBundle: (id: string) => Promise<void>;
  clearCart: () => Promise<void>;
  syncCartToBackend: () => Promise<void>;
  /** Refetch the server cart and update local state. Used by WaTokenHydrator. */
  refetchCart: () => Promise<void>;
  itemCount: number;
  total: number;
}

const CartContext = createContext<CartContextType | undefined>(undefined);

// Per-store localStorage key. Path-based stores (store.forcemediakw.com/<slug>)
// share one origin, so a flat 'force-store-cart' key bled one store's guest
// cart into another on the same browser (visual-only — the server cart is
// already storeId-scoped, but the optimistic first paint showed the wrong
// store's items). Namespacing by store.id isolates each store's cached cart.
// `legacy` is the old flat key, kept only so we can purge it post-migration.
const LEGACY_CART_STORAGE_KEY = 'force-store-cart';
function cartStorageKeyFor(storeId: string | undefined): string {
  return storeId && storeId !== 'demo' ? `force-store-cart:${storeId}` : LEGACY_CART_STORAGE_KEY;
}

function mapServerItem(item: ServerCartItem): CartItem {
  return {
    id: item.id,
    productId: item.productId,
    name: item.product.name,
    nameAr: item.product.nameAr ?? undefined,
    // Show the chosen variant's price (fall back to the parent product for
    // variant-less products) — matches what the server charges.
    price: item.variant?.price ?? item.product.price,
    quantity: item.quantity,
    image: item.product.images?.[0]?.url,
    slug: item.product.slug,
    category: item.product.categories?.[0]?.category?.name,
    variantId: item.variantId ?? undefined,
    variantTitle: item.variant?.title ?? undefined,
    variantTitleAr: item.variant?.titleAr ?? undefined,
  };
}

function mapServerBundle(bundle: ServerCartBundle): CartBundle {
  return {
    id: bundle.id,
    bundleId: bundle.bundleId,
    name: bundle.name,
    nameAr: bundle.nameAr ?? undefined,
    image: bundle.image ?? undefined,
    quantity: bundle.quantity,
    unitPrice: bundle.unitPrice,
    total: bundle.total,
    available: bundle.available,
  };
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [bundles, setBundles] = useState<CartBundle[]>([]);
  const [isReady, setIsReady] = useState(false);
  const migratedRef = useRef(false);
  const toast = useToast();
  const { t, language } = useLanguage();
  // On the platform domain root (store.forcemediakw.com/) there is no resolved
  // store, so `store.id` is the 'demo' sentinel and ApiClient never gets an
  // X-Store-ID. Calling GET /public/cart in that state 400s with
  // STORE_NOT_RESOLVED (~115x/day in Sentry). Gate every cart round-trip on a
  // real store; without one the cart is purely localStorage until a store
  // resolves (deps re-run hydrate when it does).
  const { store } = useStore();
  const hasStore = !!store?.id && store.id !== 'demo';
  // Storage key is per-store; recomputed when the store resolves so each store
  // reads/writes only its own cached cart.
  const cartStorageKey = cartStorageKeyFor(store?.id);

  // Fast first paint: load cached items from localStorage before the server
  // round-trip. These are overwritten once the authoritative cart arrives.
  // Re-runs when the store (and thus the key) resolves so we paint the right
  // store's cache, not a stale sibling's. One-time: purge the old flat key.
  useEffect(() => {
    try {
      if (cartStorageKey !== LEGACY_CART_STORAGE_KEY) {
        localStorage.removeItem(LEGACY_CART_STORAGE_KEY);
      }
      const saved = localStorage.getItem(cartStorageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setItems(parsed as CartItem[]);
        }
      }
    } catch {
      // Corrupt JSON -- ignore.
    }
  }, [cartStorageKey]);

  const refetchCart = useCallback(async () => {
    if (!hasStore) return;
    const res = await api.getCart();
    if (res.success && res.data?.cart) {
      setItems((res.data.cart.items as ServerCartItem[]).map(mapServerItem));
      setBundles(
        ((res.data.cart.bundles as ServerCartBundle[] | undefined) ?? []).map(mapServerBundle)
      );
    }
  }, [hasStore]);

  // Hydrate from the server cart. If the server cart is empty but we have
  // local items (pre-fix users or guests who added items before hydration),
  // migrate them to the server so checkout + order creation work.
  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      // No resolved store (platform root) -> skip the server cart entirely;
      // the localStorage cart is still painted and isReady unblocks the UI.
      if (!hasStore) {
        if (!cancelled) setIsReady(true);
        return;
      }
      try {
        const res = await api.getCart();
        if (cancelled) return;
        if (!res.success || !res.data?.cart) {
          return;
        }

        const serverItems = (res.data.cart.items as ServerCartItem[]).map(mapServerItem);
        const serverBundles = ((res.data.cart.bundles as ServerCartBundle[] | undefined) ?? []).map(
          mapServerBundle
        );
        // A cart holding ONLY bundles (no loose items) is valid — don't treat
        // it as empty and try to migrate the guest's local items over it.
        const hasServerContent = serverItems.length > 0 || serverBundles.length > 0;

        // Read localStorage directly instead of the React state `items` so we
        // don't need it in the effect deps (which would re-run the migration).
        const localItems = readLocalCart(cartStorageKey);

        if (!hasServerContent && localItems.length > 0 && !migratedRef.current) {
          migratedRef.current = true;
          const syncPayload = toSyncPayload(localItems);
          if (syncPayload.length > 0) {
            await api.syncCart(syncPayload);
          }
          if (cancelled) return;
          await refetchCart();
        } else {
          setItems(serverItems);
          setBundles(serverBundles);
        }
      } catch {
        // Network error -- keep whatever was loaded from localStorage.
      } finally {
        if (!cancelled) setIsReady(true);
      }
    }

    hydrate();
    return () => {
      cancelled = true;
    };
  }, [refetchCart, hasStore, cartStorageKey]);

  // Persist to localStorage so the next page load can paint the cart
  // instantly while the server round-trip is in flight.
  useEffect(() => {
    if (!isReady) return;
    try {
      localStorage.setItem(cartStorageKey, JSON.stringify(items));
    } catch {
      // Quota exceeded or storage disabled -- non-fatal.
    }
  }, [items, isReady, cartStorageKey]);

  const addItem = useCallback(
    async (
      item: Omit<CartItem, 'quantity' | 'productId'>,
      quantity: number = 1
    ): Promise<boolean> => {
      const productId = item.id;

      // Optimistic update so the cart badge + drawer update immediately.
      setItems(prev => {
        const existing = prev.find(
          i => i.productId === productId && i.variantId === item.variantId
        );
        if (existing) {
          return prev.map(i =>
            i.productId === productId && i.variantId === item.variantId
              ? { ...i, quantity: i.quantity + quantity }
              : i
          );
        }
        return [
          ...prev,
          {
            id: productId,
            productId,
            quantity,
            name: item.name,
            nameAr: item.nameAr,
            price: item.price,
            slug: item.slug,
            image: item.image,
            category: item.category,
            variantId: item.variantId,
          },
        ];
      });

      try {
        const res = await api.addToCart(productId, quantity, item.variantId ?? undefined);
        if (res.success && res.data?.cart) {
          setItems((res.data.cart.items as ServerCartItem[]).map(mapServerItem));
          setBundles(
            ((res.data.cart.bundles as ServerCartBundle[] | undefined) ?? []).map(mapServerBundle)
          );
        } else {
          await refetchCart();
          throw new Error(res.error?.message || 'Failed to add item to cart');
        }
        // Toast feedback for user-initiated adds. The guest auto-merge path
        // calls `api.addToCart` directly (see hydrate()) and bypasses this
        // function entirely, so it stays silent. The cart page only uses
        // updateQuantity/removeItem, never addItem, so quantity bumps from
        // the cart drawer/page never reach this branch.
        const localizedName = language === 'ar' && item.nameAr ? item.nameAr : item.name;
        toast.success(t('Added to cart', 'تمت الإضافة للسلة'), localizedName);
        return true;
      } catch {
        await refetchCart().catch(() => {});
        // Centralized failure feedback: every storefront add-to-cart call site is
        // fire-and-forget, so a silent throw meant the user got NO signal an add
        // failed (the item just never appeared). Mirror the success toast here and
        // return false instead of throwing — so no call site can leak an unhandled
        // rejection, and a caller that cares (e.g. the PDP conversion pixel) can
        // branch on the result.
        toast.error(
          t('Unable to add to cart', 'تعذّرت الإضافة للسلة'),
          t('Please try again.', 'يرجى المحاولة مرة أخرى.')
        );
        return false;
      }
    },
    [refetchCart, toast, t, language]
  );

  const removeItem = useCallback(
    async (id: string) => {
      setItems(prev => prev.filter(i => i.id !== id));
      try {
        const res = await api.removeCartItem(id);
        if (res.success && res.data?.cart) {
          setItems((res.data.cart.items as ServerCartItem[]).map(mapServerItem));
          setBundles(
            ((res.data.cart.bundles as ServerCartBundle[] | undefined) ?? []).map(mapServerBundle)
          );
        } else {
          await refetchCart();
          throw new Error(res.error?.message || 'Failed to remove item');
        }
      } catch (err) {
        await refetchCart().catch(() => {});
        throw err;
      }
    },
    [refetchCart]
  );

  const updateQuantity = useCallback(
    async (id: string, quantity: number) => {
      if (quantity <= 0) {
        await removeItem(id);
        return;
      }
      setItems(prev => prev.map(i => (i.id === id ? { ...i, quantity } : i)));
      try {
        const res = await api.updateCartItem(id, quantity);
        if (res.success && res.data?.cart) {
          setItems((res.data.cart.items as ServerCartItem[]).map(mapServerItem));
          setBundles(
            ((res.data.cart.bundles as ServerCartBundle[] | undefined) ?? []).map(mapServerBundle)
          );
        } else {
          await refetchCart();
          throw new Error(res.error?.message || 'Failed to update item');
        }
      } catch (err) {
        await refetchCart().catch(() => {});
        throw err;
      }
    },
    [refetchCart, removeItem]
  );

  // A bundle is never expanded into `cart_items` — it lives in its own
  // `CartBundle` row (see cart.service.ts). `api.addBundleToCart`/
  // `removeCartBundle` call `/public/cart/bundles[/:id]` (public.routes.ts)
  // — NOT the store-scoped `/stores/:storeId/cart/bundles[/:id]` Task 5
  // originally shipped, which `restrictPlatformOnlyOrigins` blocks for
  // every non-platform origin (i.e. every real merchant storefront) in
  // production. See public.routes.ts's comment on those two routes for the
  // full story.
  const addBundle = useCallback(
    async (bundleId: string, quantity: number = 1): Promise<boolean> => {
      if (!hasStore || !store?.id) return false;
      try {
        const res = await api.addBundleToCart(bundleId, quantity);
        if (res.success && res.data?.cart) {
          setItems((res.data.cart.items as ServerCartItem[]).map(mapServerItem));
          setBundles(
            ((res.data.cart.bundles as ServerCartBundle[] | undefined) ?? []).map(mapServerBundle)
          );
          toast.success(
            t('Added to cart', 'تمت الإضافة للسلة'),
            t('Bundle added to your cart', 'تمت إضافة الباقة إلى سلتك')
          );
          return true;
        }

        await refetchCart().catch(() => {});
        // See bundle-cart-errors.ts: this route's business-rule refusals
        // arrive as a flat error STRING, not this app's usual
        // `{code,message}` envelope — a customer must never see the generic
        // fallback copy for a condition (`bundle_not_purchasable` /
        // `insufficient_stock`) the API named precisely.
        const { title, message } = bundleCartErrorCopy(classifyBundleCartError(res.error), t);
        toast.error(title, message);
        return false;
      } catch {
        await refetchCart().catch(() => {});
        toast.error(
          t('Unable to add to cart', 'تعذّرت الإضافة للسلة'),
          t('Please try again.', 'يرجى المحاولة مرة أخرى.')
        );
        return false;
      }
    },
    [hasStore, store, refetchCart, toast, t]
  );

  const removeBundle = useCallback(
    async (id: string): Promise<void> => {
      setBundles(prev => prev.filter(b => b.id !== id));
      if (!hasStore || !store?.id) return;
      try {
        const res = await api.removeCartBundle(id);
        if (res.success && res.data?.cart) {
          setItems((res.data.cart.items as ServerCartItem[]).map(mapServerItem));
          setBundles(
            ((res.data.cart.bundles as ServerCartBundle[] | undefined) ?? []).map(mapServerBundle)
          );
        } else {
          await refetchCart();
          throw new Error(res.error?.message || 'Failed to remove bundle');
        }
      } catch (err) {
        await refetchCart().catch(() => {});
        throw err;
      }
    },
    [hasStore, store, refetchCart]
  );

  const clearCart = useCallback(async () => {
    setItems([]);
    setBundles([]);
    try {
      const res = await api.clearCart();
      if (!res.success) {
        await refetchCart();
      }
    } catch {
      await refetchCart().catch(() => {});
    }
  }, [refetchCart]);

  // Every mutation already writes through to the server, so this is just a
  // refetch to pick up any server-side reconciliation on login (e.g. a
  // customer-owned cart from a previous session).
  const syncCartToBackend = useCallback(async () => {
    await refetchCart().catch(() => {});
  }, [refetchCart]);

  const itemCount =
    items.reduce((sum, item) => sum + item.quantity, 0) +
    bundles.reduce((sum, b) => sum + b.quantity, 0);
  const total =
    items.reduce((sum, item) => sum + item.price * item.quantity, 0) +
    bundles.reduce((sum, b) => sum + b.total, 0);

  return (
    <CartContext.Provider
      value={{
        items,
        bundles,
        isReady,
        addItem,
        removeItem,
        updateQuantity,
        addBundle,
        removeBundle,
        clearCart,
        syncCartToBackend,
        refetchCart,
        itemCount,
        total,
      }}
    >
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  const context = useContext(CartContext);
  if (context === undefined) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return context;
}
