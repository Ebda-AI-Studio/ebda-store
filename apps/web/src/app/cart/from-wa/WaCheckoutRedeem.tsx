'use client';

/**
 * `/cart/from-wa?t=<token>` (Ruling WA-RPC-3): POST the signed token to the store's API, which copies its lines into THIS browser's
 * session cart (re-priced by the Store; idempotent), then send the shopper to /cart with the token gone from the URL. An expired or
 * invalid link still lands on the normal cart: the shopper is never stranded on an error page. Waits for CartContext.isReady so its
 * hydrate() cannot overwrite the added lines (same race as CartRestoreHydrator).
 */

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCart } from '../../../contexts/CartContext';
import { api } from '../../../lib/api';
import { useStoreUrl } from '../../../contexts/StoreContext';

export default function WaCheckoutRedeem() {
  const router = useRouter();
  const storeUrl = useStoreUrl();
  const params = useSearchParams();
  const { isReady, refetchCart } = useCart();
  const ranRef = useRef(false);

  useEffect(() => {
    if (!isReady || ranRef.current) return;
    ranRef.current = true;
    const token = params.get('t');
    (async () => {
      try {
        if (token) {
          const res = await api.post<{ added: number }>('/public/cart/from-wa', { token });
          if (res.success) await refetchCart().catch(() => {});
        }
      } catch {
        // expired or invalid: fall through to the normal cart
      } finally {
        router.replace(storeUrl('/cart'));
      }
    })();
  }, [isReady, params, refetchCart, router, storeUrl]);

  return (
    <main className="mx-auto flex min-h-[40vh] w-full max-w-md items-center justify-center px-4">
      <div
        className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-foreground"
        aria-hidden
      />
      <span className="sr-only">Loading your cart</span>
    </main>
  );
}
