'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../../../../../lib/api';
import type { AnswerEngineSummary } from '../_components/types';

interface UseAnswerEngineSummaryArgs {
  storeId: string;
  /** Skip the fetch entirely while the feature gate hasn't resolved yet or
   * is disabled — mirrors `usePaymentAbandonments`'s `enabled` param. */
  enabled: boolean;
}

const EMPTY_SUMMARY: AnswerEngineSummary = {
  engines: [],
  trend: [],
  prompts: [],
  lastRunAt: null,
};

export function useAnswerEngineSummary({ storeId, enabled }: UseAnswerEngineSummaryArgs) {
  const [summary, setSummary] = useState<AnswerEngineSummary>(EMPTY_SUMMARY);
  const [isLoading, setIsLoading] = useState(true);
  // Failed load's message (`''` = failed without one). A 403/500 used to be
  // logged and swallowed, so it rendered as "no data" (2026-09-30 audit).
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    if (!storeId || !enabled) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: apiError } = await apiGet<AnswerEngineSummary>(
        `/api/v1/stores/${storeId}/answer-engine/summary`
      );
      if (data) setSummary(data);
      if (apiError) setError(apiError.message ?? '');
    } catch (err) {
      console.error('Failed to fetch answer-engine summary:', err);
      setError(err instanceof Error ? err.message : '');
    } finally {
      setIsLoading(false);
    }
  }, [storeId, enabled]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  return { summary, isLoading, error, refetch: fetchSummary };
}
