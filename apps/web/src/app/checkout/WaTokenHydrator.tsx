'use client';

/**
 * WA-token cart hydrator (Phase 6 / Option C, FWB storefront).
 *
 * When the checkout URL carries ?waToken=<jwt>, redeem it via the
 * /api/v1/wa-bridge/cart/redeem endpoint to recover the cart payload
 * that WBS handed off. Hydrate the server cart via individual
 * api.addToCart calls, then refetchCart so the UI reflects the server
 * truth. Strips the token from the URL to prevent double-hydration on
 * refresh.
 *
 * Race condition fix (Issue 4): we wait for CartContext.isReady before
 * running so CartContext.hydrate() has already settled. This prevents
 * the hydrate() useEffect from overwriting our items with an empty cart.
 *
 * Idempotent: sessionStorage marker prevents re-running on HMR /
 * strict-mode double-mount.
 */

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCart } from '../../contexts/CartContext';
import { api, API_URL } from '../../lib/api';

interface WaCartItem {
  productId: string;
  quantity: number;
  priceFils?: number;
  name?: string;
  nameAr?: string;
}
interface WaCartPayload {
  storeId: string;
  storeSlug: string;
  customerPhone: string;
  customerName: string | null;
  locale: string;
  items: WaCartItem[];
  totalFils: number;
  currency: string;
}

const SESSION_KEY = 'fwb.wa-cart-redeemed';

export default function WaTokenHydrator() {
  const router = useRouter();
  const params = useSearchParams();
  const { isReady, refetchCart } = useCart();
  const ranRef = useRef(false);

  useEffect(() => {
    // Issue 4: wait until CartContext.hydrate() has settled so we don't race
    // with its setItems(serverItems) call overwriting our additions.
    if (!isReady) return;
    if (ranRef.current) return;
    const token = params.get('waToken');
    if (!token) return;

    // sessionStorage marker — survive HMR + strict-mode double-mount.
    const already = (() => {
      try {
        return window.sessionStorage.getItem(SESSION_KEY) === token;
      } catch {
        return false;
      }
    })();
    if (already) return;
    ranRef.current = true;
    try {
      window.sessionStorage.setItem(SESSION_KEY, token);
    } catch {
      /* private mode */
    }

    (async () => {
      try {
        // API_URL already includes the /api/v1 prefix (see lib/api.ts) — do not
        // re-append it here or the request 404s on /api/v1/api/v1/...
        const res = await fetch(`${API_URL}/wa-bridge/cart/redeem`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ token }),
        });
        if (!res.ok) {
          // eslint-disable-next-line no-console
          console.warn('[wa-token-hydrator] redeem failed', res.status);
          return;
        }
        const json = await res.json();
        const data: WaCartPayload | undefined = json?.data;
        if (!data || !Array.isArray(data.items) || data.items.length === 0) return;

        // Issue 4: call api.addToCart directly (bypassing the addItem
        // optimistic update + toast) and refetch once at the end so the UI
        // reflects the server-authoritative cart state. Sequential to preserve
        // order and avoid duplicate-detection races.
        let anyAdded = false;
        for (const item of data.items) {
          if (!item.productId || !item.quantity || item.quantity < 1) continue;
          const addRes = await api.addToCart(item.productId, item.quantity);
          if (addRes.success) {
            anyAdded = true;
          } else {
            // eslint-disable-next-line no-console
            console.warn('[wa-token-hydrator] addToCart failed for', item.productId, addRes.error);
          }
        }

        if (anyAdded) {
          // Refetch to get the authoritative server cart state (prices,
          // stock status, slugs) rather than relying on the JWT snapshot.
          await refetchCart().catch(() => {});
        }

        // Stash customer phone for the shipping-step pre-fill.
        if (data.customerPhone) {
          try {
            window.sessionStorage.setItem('fwb.wa-customer-phone', data.customerPhone);
          } catch {
            /* ignore */
          }
        }

        // Strip the token from the URL so a refresh doesn't re-redeem.
        const url = new URL(window.location.href);
        url.searchParams.delete('waToken');
        router.replace(url.pathname + url.search, { scroll: false });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[wa-token-hydrator] failed', (err as Error).message);
      }
    })();
  }, [isReady, params, refetchCart, router]);

  return null;
}
