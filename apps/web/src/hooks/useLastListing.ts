'use client';

import { useState, useEffect } from 'react';
import { useStore, useStoreUrl } from '../contexts/StoreContext';
import { getLastListing } from '../lib/last-listing';

/**
 * Returns the href the "Continue Shopping" button should point to.
 *
 * - On first render (SSR + hydration): returns the fallback `/products` href
 *   so there is no hydration mismatch.
 * - After mount: reads sessionStorage for the last-browsed listing URL and
 *   returns that, or falls back to `/products` when nothing is recorded yet.
 *
 * The returned href is already passed through `storeUrl()` so it carries
 * the correct slug prefix (platform host) or bare path (custom domain).
 */
export function useLastListing(): string {
  const { store } = useStore();
  const storeUrl = useStoreUrl();

  // Always start with the fallback to avoid hydration mismatch — the
  // sessionStorage read only happens client-side in the effect below.
  const [href, setHref] = useState(() => storeUrl('/products'));

  useEffect(() => {
    const stored = getLastListing(store?.id);
    setHref(storeUrl(stored ?? '/products'));
    // Re-evaluate if the store changes (e.g. demo → real store hydration).
    // storeUrl is intentionally omitted because its reference changes on every
    // render (it's a useCallback); store.id is the stable dependency we care about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store?.id]);

  return href;
}
