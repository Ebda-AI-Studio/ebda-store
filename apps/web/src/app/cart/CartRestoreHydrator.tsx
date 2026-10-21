'use client';

/**
 * Cart-recovery email landing (Ruling CART-RESTORE-1).
 *
 * The reminder email's button opens `/cart?restore=<token>`. The token is signed, expiring and
 * store-scoped; POST /public/cart/restore copies the emailed cart's lines into THIS browser's
 * session cart (guests included, no sign-in needed), then we refetch and strip the token from the
 * URL. Idempotent on the server (lines already in the cart are not added again), and a sessionStorage
 * marker stops a strict-mode double mount or a refresh from calling twice. A failure is silent on
 * purpose: the shopper just sees their normal cart.
 *
 * Waits for CartContext.isReady so its hydrate() cannot overwrite the restored lines (same race as
 * the WhatsApp hydrator).
 */

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCart } from '../../contexts/CartContext';
import { api } from '../../lib/api';

const SESSION_KEY = 'ebda.cart-restore-done';

export default function CartRestoreHydrator() {
  const router = useRouter();
  const params = useSearchParams();
  const { isReady, refetchCart } = useCart();
  const ranRef = useRef(false);

  useEffect(() => {
    if (!isReady || ranRef.current) return;
    const token = params.get('restore');
    if (!token) return;
    ranRef.current = true;
    try {
      if (sessionStorage.getItem(SESSION_KEY) === token) return;
      sessionStorage.setItem(SESSION_KEY, token);
    } catch {
      // storage blocked: the server-side idempotency still protects the cart
    }

    (async () => {
      try {
        const res = await api.post<{ added: number }>('/public/cart/restore', { token });
        if (res.success && (res.data?.added ?? 0) > 0) await refetchCart().catch(() => {});
      } catch {
        // an expired or invalid link leaves the shopper on their normal cart
      } finally {
        const url = new URL(window.location.href);
        url.searchParams.delete('restore');
        router.replace(url.pathname + url.search, { scroll: false });
      }
    })();
  }, [isReady, params, refetchCart, router]);

  return null;
}
