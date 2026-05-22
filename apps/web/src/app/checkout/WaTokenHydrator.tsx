'use client';

/**
 * WA-token cart hydrator (Phase 6 / Option C, FWB storefront).
 *
 * When the checkout URL carries ?waToken=<jwt>, redeem it via the
 * /api/v1/wa-bridge/cart/redeem endpoint to recover the cart payload
 * that WBS handed off. Append every item to the customer's cart, then
 * strip the token from the URL so a refresh doesn't double-add.
 *
 * Idempotent: tracks redemption in sessionStorage so a HMR / strict-
 * mode double-mount doesn't double-add either. Errors logged + the
 * hydrator silently falls back (the customer sees an empty cart they
 * can re-build manually, rather than a stuck error state).
 */

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCart } from '../../contexts/CartContext';

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
  const { addItem } = useCart();
  const ranRef = useRef(false);

  useEffect(() => {
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
        const apiBase = process.env.NEXT_PUBLIC_API_URL || '';
        const res = await fetch(`${apiBase}/api/v1/wa-bridge/cart/redeem`, {
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
        if (!data || !Array.isArray(data.items)) return;

        // Add every item. addItem accepts a single product at a time;
        // sequential to preserve order. CartContext owns the DB sync.
        for (const item of data.items) {
          await addItem(
            {
              id: item.productId,
              name: item.name || 'Product',
              price: item.priceFils ?? 0,
            } as Parameters<typeof addItem>[0],
            item.quantity
          );
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
  }, [params, addItem, router]);

  return null;
}
