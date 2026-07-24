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

  const fetchGsc = useCallback(async () => {
    if (!storeId || !enabled) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const { data } = await apiGet<GscDashboard>(`/api/v1/stores/${storeId}/answer-engine/gsc`);
      if (data) setGsc(data);
    } catch (error) {
      console.error('Failed to fetch GSC dashboard:', error);
    } finally {
      setIsLoading(false);
    }
  }, [storeId, enabled]);

  useEffect(() => {
    fetchGsc();
  }, [fetchGsc]);

  return { gsc, isLoading, refetch: fetchGsc };
}
