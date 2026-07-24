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

  const fetchSummary = useCallback(async () => {
    if (!storeId || !enabled) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const { data } = await apiGet<AnswerEngineSummary>(
        `/api/v1/stores/${storeId}/answer-engine/summary`
      );
      if (data) setSummary(data);
    } catch (error) {
      console.error('Failed to fetch answer-engine summary:', error);
    } finally {
      setIsLoading(false);
    }
  }, [storeId, enabled]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  return { summary, isLoading, refetch: fetchSummary };
}
