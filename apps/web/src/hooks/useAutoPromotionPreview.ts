'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

export type AutoPromotion = { id: string; discount: number };

type PreviewLine = { productId: string; quantity: number };

/**
 * Automatic promotion preview for a set of lines: the SERVER evaluates it
 * (POST /stores/public/:id/promotions/preview, the same resolver order
 * creation uses). The storefront never carries category ids, so this is never
 * recomputed client-side; `discount` is minor units straight from the API.
 * Used by the PDP, the cart and checkout so all three show the same offer.
 */
export function useAutoPromotionPreview(
  storeId: string | undefined,
  lines: readonly PreviewLine[],
  who: { phone?: string; email?: string } = {},
  /** PDP / cart: their own rate bucket, so browsing never spends checkout's. A 429 just hides the hint. */
  browse = false
): AutoPromotion | null {
  const [promotion, setPromotion] = useState<AutoPromotion | null>(null);
  // The last signature actually sent: an unrelated re-render does not refire.
  const sentRef = useRef('');
  const { phone, email } = who;
  const linesKey = JSON.stringify(lines.map(l => [l.productId, l.quantity]));

  useEffect(() => {
    const items = (JSON.parse(linesKey) as [string, number][]).map(([productId, quantity]) => ({
      productId,
      quantity,
    }));
    if (!storeId || items.length === 0) {
      setPromotion(null);
      sentRef.current = '';
      return;
    }
    const signature = JSON.stringify({ storeId, items, phone, email });
    if (signature === sentRef.current) return;
    // Debounced: the endpoint is rate-limited (20/min/IP).
    const timeoutId = setTimeout(() => {
      sentRef.current = signature;
      api
        .post<{ promotion: AutoPromotion | null }>(
          `/stores/public/${storeId}/promotions/${browse ? 'preview-browse' : 'preview'}`,
          {
            items,
            phone,
            email,
          }
        )
        .then(r => setPromotion(r.success ? (r.data?.promotion ?? null) : null))
        .catch(() => setPromotion(null));
    }, 400);
    return () => clearTimeout(timeoutId);
  }, [storeId, linesKey, phone, email, browse]);

  return promotion;
}
