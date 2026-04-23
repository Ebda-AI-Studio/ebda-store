'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { api } from '@/lib/api';

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
}

interface CartContextType {
  items: CartItem[];
  isReady: boolean;
  addItem: (item: Omit<CartItem, 'quantity' | 'productId'>, quantity?: number) => Promise<void>;
  removeItem: (id: string) => Promise<void>;
  updateQuantity: (id: string, quantity: number) => Promise<void>;
  clearCart: () => Promise<void>;
  syncCartToBackend: () => Promise<void>;
  itemCount: number;
  total: number;
}

const CartContext = createContext<CartContextType | undefined>(undefined);

const CART_STORAGE_KEY = 'force-store-cart';

function mapServerItem(item: ServerCartItem): CartItem {
  return {
    id: item.id,
    productId: item.productId,
    name: item.product.name,
    nameAr: item.product.nameAr ?? undefined,
    price: item.product.price,
    quantity: item.quantity,
    image: item.product.images?.[0]?.url,
    slug: item.product.slug,
    category: item.product.categories?.[0]?.category?.name,
    variantId: item.variantId ?? undefined,
  };
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [isReady, setIsReady] = useState(false);
  const migratedRef = useRef(false);

  // Fast first paint: load cached items from localStorage before the server
  // round-trip. These are overwritten once the authoritative cart arrives.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(CART_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setItems(parsed as CartItem[]);
        }
      }
    } catch {
      // Corrupt JSON -- ignore.
    }
  }, []);

  const refetchCart = useCallback(async () => {
    const res = await api.getCart();
    if (res.success && res.data?.cart) {
      setItems((res.data.cart.items as ServerCartItem[]).map(mapServerItem));
    }
  }, []);

  // Hydrate from the server cart. If the server cart is empty but we have
  // local items (pre-fix users or guests who added items before hydration),
  // migrate them to the server so checkout + order creation work.
  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      try {
        const res = await api.getCart();
        if (cancelled) return;
        if (!res.success || !res.data?.cart) {
          return;
        }

        const serverItems = (res.data.cart.items as ServerCartItem[]).map(mapServerItem);
        const hasServerItems = serverItems.length > 0;

        // Read localStorage directly instead of the React state `items` so we
        // don't need it in the effect deps (which would re-run the migration).
        let localItems: CartItem[] = [];
        try {
          const saved = localStorage.getItem(CART_STORAGE_KEY);
          if (saved) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed)) localItems = parsed as CartItem[];
          }
        } catch {
          // ignore
        }

        if (!hasServerItems && localItems.length > 0 && !migratedRef.current) {
          migratedRef.current = true;
          await Promise.allSettled(
            localItems.map(i => api.addToCart(i.productId || i.id, i.quantity))
          );
          if (cancelled) return;
          await refetchCart();
        } else {
          setItems(serverItems);
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
  }, [refetchCart]);

  // Persist to localStorage so the next page load can paint the cart
  // instantly while the server round-trip is in flight.
  useEffect(() => {
    if (!isReady) return;
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(items));
    } catch {
      // Quota exceeded or storage disabled -- non-fatal.
    }
  }, [items, isReady]);

  const addItem = useCallback(
    async (item: Omit<CartItem, 'quantity' | 'productId'>, quantity: number = 1) => {
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
        const res = await api.addToCart(productId, quantity);
        if (res.success && res.data?.cart) {
          setItems((res.data.cart.items as ServerCartItem[]).map(mapServerItem));
        } else {
          await refetchCart();
          throw new Error(res.error?.message || 'Failed to add item to cart');
        }
      } catch (err) {
        await refetchCart().catch(() => {});
        throw err;
      }
    },
    [refetchCart]
  );

  const removeItem = useCallback(
    async (id: string) => {
      setItems(prev => prev.filter(i => i.id !== id));
      try {
        const res = await api.removeCartItem(id);
        if (res.success && res.data?.cart) {
          setItems((res.data.cart.items as ServerCartItem[]).map(mapServerItem));
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

  const clearCart = useCallback(async () => {
    setItems([]);
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

  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

  return (
    <CartContext.Provider
      value={{
        items,
        isReady,
        addItem,
        removeItem,
        updateQuantity,
        clearCart,
        syncCartToBackend,
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
