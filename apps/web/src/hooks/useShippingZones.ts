'use client';

import { useEffect, useState } from 'react';
import { API_URL } from '@/lib/api';

/**
 * Load a store's public shipping zones.
 *
 * Extracted from ShippingClient so the response-shape guard is testable. That
 * guard is the whole point: the endpoint can answer `success: false`, or answer
 * success with no `zones` array at all, and both must land on the error state
 * rather than rendering an empty shipping page as though the merchant had
 * configured no zones.
 *
 * The `demo` placeholder store id is skipped deliberately — it is the default
 * before a real store resolves, and fetching for it 404s on every page load.
 */
export function useShippingZones<T>(storeId: string | undefined) {
  const [zones, setZones] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    if (!storeId || storeId === 'demo') return;

    setIsLoading(true);
    setFetchError(false);

    fetch(`${API_URL}/stores/public/${storeId}/shipping`)
      .then(res => res.json())
      .then(json => {
        if (json.success && Array.isArray(json.data?.zones)) {
          setZones(json.data.zones as T[]);
        } else {
          setFetchError(true);
        }
      })
      .catch(() => setFetchError(true))
      .finally(() => setIsLoading(false));
  }, [storeId]);

  return { zones, isLoading, fetchError };
}

/**
 * The response-shape decision, separated so it can be asserted directly.
 * Returns the zones to show, or null meaning "treat this as a failure".
 */
export function zonesFromResponse<T = unknown>(json: unknown): T[] | null {
  const body = json as { success?: boolean; data?: { zones?: unknown } } | null | undefined;
  if (body?.success && Array.isArray(body.data?.zones)) {
    return body.data.zones as T[];
  }
  return null;
}
