'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../../../../../lib/api';
import type { FeedHealth, FeedLang } from '../_components/types';

/** Feed health for one language. `error` is the failed load's message ('' = failed without one); never rendered as "no data". */
export function useFeedHealth({
  storeId,
  lang,
  enabled,
}: {
  storeId: string;
  lang: FeedLang;
  enabled: boolean;
}) {
  const [health, setHealth] = useState<FeedHealth | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!storeId || !enabled) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: apiError } = await apiGet<FeedHealth>(
        `/api/v1/stores/${storeId}/product-feeds/health?lang=${lang}`
      );
      if (data) setHealth(data);
      if (apiError) setError(apiError.message ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : '');
    } finally {
      setIsLoading(false);
    }
  }, [storeId, lang, enabled]);

  useEffect(() => {
    load();
  }, [load]);

  return { health, isLoading, error, refetch: load };
}
