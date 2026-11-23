'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../../../../lib/api';

/** `null` while loading, `'error'` when that one count could not be read (never shown as zero). */
export type NeedCount = number | null | 'error';

export interface NeedsAction {
  newOrders: NeedCount;
  lowStock: NeedCount;
  pendingReturns: NeedCount;
  pendingReviews: NeedCount;
  /** 1 when the store has no SEO title/description in any language (STORE-QA-29), else 0. */
  seoMissing: NeedCount;
}

const LOADING: NeedsAction = {
  newOrders: null,
  lowStock: null,
  pendingReturns: null,
  pendingReviews: null,
  seoMissing: null,
};

/**
 * The four counts behind the dashboard's "محتاج تصرّف" row (UX:D-2), each from an endpoint that already exists
 * (orders list meta, low-stock analytics, returns stats, reviews admin list). A plan that does not include
 * returns / reviews answers 402/403: that count is `'error'` and its tile is hidden, never "0".
 */
export function useNeedsAction(storeId: string): { counts: NeedsAction; reload: () => void } {
  const [counts, setCounts] = useState<NeedsAction>(LOADING);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    const base = `/api/v1/stores/${storeId}`;
    const set = (key: keyof NeedsAction) => (value: NeedCount) => {
      if (!cancelled) setCounts(prev => ({ ...prev, [key]: value }));
    };
    setCounts(LOADING);

    void apiGet<{ meta?: { total?: number }; pagination?: { total?: number } }>(
      `${base}/orders?status=pending&limit=1`
    ).then(({ data, error }) =>
      set('newOrders')(error ? 'error' : (data?.meta?.total ?? data?.pagination?.total ?? 0))
    );
    void apiGet<{ products?: unknown[] }>(`${base}/analytics/low-stock`).then(({ data, error }) =>
      set('lowStock')(error ? 'error' : (data?.products?.length ?? 0))
    );
    void apiGet<{ stats?: { pending?: number } }>(`${base}/returns/admin/stats`).then(
      ({ data, error }) => set('pendingReturns')(error ? 'error' : (data?.stats?.pending ?? 0))
    );
    void apiGet<{ meta?: { total?: number } }>(`${base}/reviews/admin?status=pending&limit=1`).then(
      ({ data, error }) => set('pendingReviews')(error ? 'error' : (data?.meta?.total ?? 0))
    );
    void apiGet<{
      seo?: {
        metaTitle?: string;
        metaTitleAr?: string;
        metaDescription?: string;
        metaDescriptionAr?: string;
      };
    }>(`${base}/seo`).then(({ data, error }) => {
      const seo = data?.seo;
      const empty =
        !seo?.metaTitle && !seo?.metaTitleAr && !seo?.metaDescription && !seo?.metaDescriptionAr;
      set('seoMissing')(error || !seo ? 'error' : empty ? 1 : 0);
    });

    return () => {
      cancelled = true;
    };
  }, [storeId, tick]);

  return { counts, reload };
}
