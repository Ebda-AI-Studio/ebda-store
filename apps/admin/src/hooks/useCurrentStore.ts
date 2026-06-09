'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiGet } from '@/lib/api';

/**
 * Superset of the store fields any admin page has been observed reading
 * from the per-page `apiGet('/api/v1/stores/:id')` calls this hook
 * replaces. Every consumer that previously defined its own inline
 * `Store` or `StoreResponse` interface should pull from here instead.
 */
export interface Store {
  id: string;
  name: string;
  nameAr?: string;
  slug: string;
  domain?: string;
  logo?: string;
  logoAr?: string;
  favicon?: string;
  description?: string;
  descriptionAr?: string;
  currency: string;
  timezone: string;
  template: string;
  theme?: Record<string, unknown>;
  socialLinks?: Record<string, unknown>;
  email?: string;
  phone?: string;
  phoneAr?: string;
  whatsapp?: string;
  address?: string;
  addressAr?: string;
  settings?: Record<string, unknown> | null;
  enabledFeatures?: string[];
  // Hero
  heroTitle?: string | null;
  heroTitleAr?: string | null;
  heroSubtitle?: string | null;
  heroSubtitleAr?: string | null;
  heroCtaText?: string | null;
  heroCtaTextAr?: string | null;
  heroCtaLink?: string | null;
  heroImage?: string | null;
  // SEO — email sender local-part (the prefix before @ on outbound mail).
  // Configured on the /seo page; the /domain DNS preview reads it so the
  // shown sender matches the address real mail is sent from.
  emailSenderLocalPart?: string | null;
  // Marketing pixels — stored as a JSON blob on the store record
  marketingPixels?: Record<string, unknown>;
  // Dashboard/admin fields — present on GET /stores/:id responses, used by
  // the super-admin store detail screen. Optional because narrow consumers
  // (hero, domain, branding, etc.) don't depend on them.
  status?: string;
  plan?: string;
  createdAt?: string;
  updatedAt?: string;
  owner?: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  _count?: {
    products: number;
    orders: number;
    customers: number;
  };
  stats?: {
    revenue: number;
    ordersThisMonth: number;
  };
}

// Module-scope caches dedupe concurrent calls and avoid refetching on
// route transitions within the same admin session. The cache is cleared
// manually via refetch() or by a full page reload.
const cache = new Map<string, Store>();
const inFlight = new Map<string, Promise<Store | null>>();

async function fetchStore(storeId: string): Promise<Store | null> {
  const existing = inFlight.get(storeId);
  if (existing) return existing;

  const promise = apiGet<{ store: Store }>(`/api/v1/stores/${storeId}`).then(res => {
    if (res.error || !res.data?.store) return null;
    cache.set(storeId, res.data.store);
    return res.data.store;
  });
  inFlight.set(storeId, promise);
  // Clear the in-flight marker once settled, success or not, so a later
  // refetch() can fire a new request.
  void promise.finally(() => inFlight.delete(storeId));
  return promise;
}

/**
 * Fetch a single store by id with in-memory dedupe + cache. Replaces the
 * ad-hoc `useState<Store | null>` + `useEffect(() => apiGet(...))` blocks
 * that had been duplicated across ~8 admin pages.
 *
 * - Concurrent calls for the same storeId share one network request.
 * - Subsequent mounts read from the cache (zero network, synchronous).
 * - Call `refetch()` to invalidate the cache entry and re-fetch.
 *
 * Not used for per-section mutations (branding, theme, contact, etc.) —
 * those still hit their dedicated endpoints. This is the *read* side.
 */
export function useCurrentStore(storeId: string | null | undefined) {
  const [store, setStore] = useState<Store | null>(() =>
    storeId && cache.has(storeId) ? cache.get(storeId)! : null
  );
  const [isLoading, setIsLoading] = useState<boolean>(() =>
    storeId ? !cache.has(storeId) : false
  );
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!storeId) {
      setStore(null);
      setIsLoading(false);
      return;
    }

    if (cache.has(storeId)) {
      setStore(cache.get(storeId)!);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    fetchStore(storeId)
      .then(s => {
        if (cancelled) return;
        if (s) setStore(s);
        else setError(new Error('Store not found'));
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [storeId]);

  const refetch = useCallback(async () => {
    if (!storeId) return;
    cache.delete(storeId);
    inFlight.delete(storeId);
    setIsLoading(true);
    setError(null);
    try {
      const s = await fetchStore(storeId);
      if (s) setStore(s);
      else setError(new Error('Store not found'));
    } finally {
      setIsLoading(false);
    }
  }, [storeId]);

  return { store, isLoading, error, refetch };
}
