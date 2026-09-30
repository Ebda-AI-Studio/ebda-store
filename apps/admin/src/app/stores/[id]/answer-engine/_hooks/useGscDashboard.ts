'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../../../../../lib/api';
import type { GscDashboard } from '../_components/types';

interface UseGscDashboardArgs {
  storeId: string;
  /** Skip the fetch entirely while the feature gate hasn't resolved yet or
   * is disabled — mirrors `useAnswerEngineSummary`'s `enabled` param. */
  enabled: boolean;
}

const EMPTY_GSC_DASHBOARD: GscDashboard = {
  connected: false,
  hasData: false,
  trend: [],
  totals: null,
  topQueries: [],
  lastUpdatedAt: null,
};

export function useGscDashboard({ storeId, enabled }: UseGscDashboardArgs) {
  const [gsc, setGsc] = useState<GscDashboard>(EMPTY_GSC_DASHBOARD);
  const [isLoading, setIsLoading] = useState(true);
  // Failed load's message (`''` = failed without one). A 403/500 used to be
  // logged and swallowed, so it rendered as "no data" (2026-09-30 audit).
  const [error, setError] = useState<string | null>(null);

  const fetchGsc = useCallback(async () => {
    if (!storeId || !enabled) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: apiError } = await apiGet<GscDashboard>(
        `/api/v1/stores/${storeId}/answer-engine/gsc`
      );
      if (data) setGsc(data);
      if (apiError) setError(apiError.message ?? '');
    } catch (err) {
      console.error('Failed to fetch GSC dashboard:', err);
      setError(err instanceof Error ? err.message : '');
    } finally {
      setIsLoading(false);
    }
  }, [storeId, enabled]);

  useEffect(() => {
    fetchGsc();
  }, [fetchGsc]);

  return { gsc, isLoading, error, refetch: fetchGsc };
}
