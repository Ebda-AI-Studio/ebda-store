'use client';

import { useState, useEffect, useCallback } from 'react';
import { API_URL } from '@/lib/api';
import type { TemplateProduct } from '../templates/types';

/**
 * Shared recommendation fetching for the product-detail sections.
 *
 * FrequentlyBoughtTogether and YouMightAlsoLike hit the SAME endpoint with the
 * same headers, the same not-ok handling and the same four-state machine — the
 * two implementations had drifted into byte-level copies of each other. The only
 * genuine difference is which slots of the response each section shows, so that
 * is the one thing callers pass in.
 *
 * The sections themselves are NOT merged: one renders an add-all-to-cart grid,
 * the other a horizontal carousel strip. Only the data lifecycle is shared.
 */

export interface RecommendedProduct {
  id: string;
  name: string;
  nameAr?: string;
  slug: string;
  price: number;
  compareAtPrice?: number;
  discountType?: 'percentage' | 'fixed' | null;
  discountValue?: number | null;
  /** Merchant-authored card badge (EN / AR). Absent = no badge. */
  badgeLabel?: string | null;
  badgeLabelAr?: string | null;
  images: Array<{ id: string; url: string; alt?: string }>;
  /** Variants of this product — empty/missing means a simple SKU. Every row,
   *  disabled ones included (a product with only disabled variants is still a
   *  variant product). Prices may be null (= the parent price). */
  variants?: Array<{ id: string; price: number | null; compareAtPrice?: number | null }>;
  /** Server-computed by enrichStockFlags (recommendation.service.ts). */
  inStock?: boolean;
  acceptsBackorder?: boolean;
  /** Variant-aware aggregate stock (sum of active variants). */
  inventory?: number;
  /** Swatch-bearing option values only (colour dots on the card). */
  options?: TemplateProduct['options'];
  /** Fact chips on the card. */
  facts?: TemplateProduct['facts'];
  has3d?: boolean;
  /** Feeds the card "New" badge. */
  createdAt?: string | null;
}

/** `loading` and `empty` are deliberately distinct from `error`: "nothing to
 *  recommend" is a normal outcome and must not render a retry prompt. */
export type RecommendationStatus = 'loading' | 'ok' | 'empty' | 'error';

interface RecommendationPayload {
  upsell?: RecommendedProduct[];
  crossSell?: RecommendedProduct[];
  alsoLike?: RecommendedProduct[];
}

/** Cross-sell slot only — what "Frequently bought together" means. */
export function selectCrossSell(data: RecommendationPayload): RecommendedProduct[] {
  return data.crossSell?.length ? data.crossSell : [];
}

/**
 * Everything the API offers, in priority order, deduped by id.
 *
 * AI recommendations arrive in the crossSell slot when no manual cross-sell
 * relations exist (recommendation.service.ts orders manual > AI > FBT), so
 * crossSell sits between upsell and alsoLike rather than being skipped.
 */
export function selectMergedRecommendations(data: RecommendationPayload): RecommendedProduct[] {
  const seen = new Set<string>();
  const merged: RecommendedProduct[] = [];
  for (const p of [...(data.upsell || []), ...(data.crossSell || []), ...(data.alsoLike || [])]) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      merged.push(p);
    }
  }
  return merged;
}

export function useProductRecommendations(
  storeId: string,
  productId: string,
  select: (data: RecommendationPayload) => RecommendedProduct[]
) {
  const [products, setProducts] = useState<RecommendedProduct[]>([]);
  const [status, setStatus] = useState<RecommendationStatus>('loading');

  const refetch = useCallback(async () => {
    if (!storeId || !productId) return;
    setStatus('loading');
    try {
      const sessionId =
        typeof window !== 'undefined' ? localStorage.getItem('sessionId') || '' : '';
      const res = await fetch(
        `${API_URL}/public/${storeId}/products/${productId}/recommendations`,
        {
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-ID': sessionId,
            'X-Store-ID': storeId,
          },
        }
      );
      if (!res.ok) {
        setStatus('error');
        return;
      }
      const data = await res.json();
      if (data.success && data.data) {
        const selected = select(data.data);
        setProducts(selected);
        setStatus(selected.length > 0 ? 'ok' : 'empty');
      } else {
        setProducts([]);
        setStatus('empty');
      }
    } catch {
      setStatus('error');
    }
    // `select` is a module-level function at every call site; including it would
    // only add a dependency that never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, productId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { products, status, refetch };
}
