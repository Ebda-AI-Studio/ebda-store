'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@force/ui';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '../../../../../lib/api';
import type { ListMeta, ReturnFilter, ReturnRecord, ReturnsStats } from '../_components/types';

interface UseReturnsArgs {
  storeId: string;
  /**
   * Called when the user invokes Reject. Should resolve with the rejection
   * reason entered in a styled modal, or null if the user cancelled.
   */
  requestRejectReason: () => Promise<string | null>;
  /**
   * Called when the user invokes Complete. Should resolve with the chosen
   * refund method, or null if the user cancelled.
   */
  requestRefundMethod: () => Promise<string | null>;
}

/**
 * Encapsulates the returns list + stats fetches and the four lifecycle
 * mutations (approve, reject, mark received, complete). Owns its toasts via
 * useToast + useT so callers no longer need to plumb an 18-key messages
 * object + onSuccess/onError callbacks through the page.
 */
export function useReturns({ storeId, requestRejectReason, requestRefundMethod }: UseReturnsArgs) {
  const toast = useToast();
  const tMessages = useT('returns.messages');
  const [returns, setReturns] = useState<ReturnRecord[]>([]);
  const [stats, setStats] = useState<ReturnsStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<ReturnFilter>('all');
  const [meta, setMeta] = useState<ListMeta>({ page: 1, limit: 20, total: 0, totalPages: 1 });

  const fetchReturns = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      const statusFilter = filter === 'all' ? '' : `&status=${filter}`;
      const { data } = await apiGet<{ returns: ReturnRecord[]; meta: ListMeta }>(
        `/api/v1/stores/${storeId}/returns/admin/list?page=${meta.page}&limit=${meta.limit}${statusFilter}`
      );
      if (data) {
        setReturns(data.returns);
        setMeta(data.meta);
      }
    } catch (error) {
      console.error('Failed to fetch returns:', error);
    } finally {
      setIsLoading(false);
    }
  }, [storeId, filter, meta.page, meta.limit]);

  const fetchStats = useCallback(async () => {
    if (!storeId) return;
    try {
      const { data } = await apiGet<{ stats: ReturnsStats }>(
        `/api/v1/stores/${storeId}/returns/admin/stats`
      );
      if (data) {
        setStats(data.stats);
      }
    } catch (error) {
      console.error('Failed to fetch stats:', error);
    }
  }, [storeId]);

  useEffect(() => {
    fetchReturns();
    fetchStats();
  }, [fetchReturns, fetchStats]);

  const refreshAll = useCallback(() => {
    fetchReturns();
    fetchStats();
  }, [fetchReturns, fetchStats]);

  const approve = useCallback(
    async (returnId: string) => {
      try {
        const { error } = await apiPost(
          `/api/v1/stores/${storeId}/returns/admin/${returnId}/approve`
        );
        if (error) {
          toast.error(tMessages('approveErrorTitle'), tMessages('approveErrorBody'));
          return false;
        }
        toast.success(tMessages('approveSuccessTitle'), tMessages('approveSuccessBody'));
        refreshAll();
        return true;
      } catch (error) {
        console.error('Failed to approve return:', error);
        toast.error(tMessages('approveErrorTitle'), tMessages('approveErrorBody'));
        return false;
      }
    },
    [storeId, toast, tMessages, refreshAll]
  );

  const reject = useCallback(
    async (returnId: string) => {
      const reason = await requestRejectReason();
      if (!reason) return false;
      try {
        const { error } = await apiPost(
          `/api/v1/stores/${storeId}/returns/admin/${returnId}/reject`,
          { reason }
        );
        if (error) {
          toast.error(tMessages('rejectErrorTitle'), tMessages('rejectErrorBody'));
          return false;
        }
        toast.success(tMessages('rejectSuccessTitle'), tMessages('rejectSuccessBody'));
        refreshAll();
        return true;
      } catch (error) {
        console.error('Failed to reject return:', error);
        toast.error(tMessages('rejectErrorTitle'), tMessages('rejectErrorBody'));
        return false;
      }
    },
    [storeId, toast, tMessages, refreshAll, requestRejectReason]
  );

  const markReceived = useCallback(
    async (returnId: string) => {
      try {
        const { error } = await apiPost(
          `/api/v1/stores/${storeId}/returns/admin/${returnId}/received`
        );
        if (error) {
          toast.error(tMessages('receivedErrorTitle'), tMessages('receivedErrorBody'));
          return false;
        }
        toast.success(tMessages('receivedSuccessTitle'), tMessages('receivedSuccessBody'));
        refreshAll();
        return true;
      } catch (error) {
        console.error('Failed to mark as received:', error);
        toast.error(tMessages('receivedErrorTitle'), tMessages('receivedErrorBody'));
        return false;
      }
    },
    [storeId, toast, tMessages, refreshAll]
  );

  const complete = useCallback(
    async (returnId: string) => {
      const refundMethod = await requestRefundMethod();
      if (!refundMethod) return false;
      try {
        const { error } = await apiPost(
          `/api/v1/stores/${storeId}/returns/admin/${returnId}/complete`,
          { refundMethod }
        );
        if (error) {
          toast.error(tMessages('completeErrorTitle'), tMessages('completeErrorBody'));
          return false;
        }
        toast.success(tMessages('completeSuccessTitle'), tMessages('completeSuccessBody'));
        refreshAll();
        return true;
      } catch (error) {
        console.error('Failed to complete return:', error);
        toast.error(tMessages('completeErrorTitle'), tMessages('completeErrorBody'));
        return false;
      }
    },
    [storeId, toast, tMessages, refreshAll, requestRefundMethod]
  );

  const changeFilter = useCallback((value: ReturnFilter) => {
    setFilter(value);
    setMeta(prev => ({ ...prev, page: 1 }));
  }, []);

  const setPage = useCallback((page: number) => {
    setMeta(prev => ({ ...prev, page }));
  }, []);

  return {
    returns,
    stats,
    isLoading,
    filter,
    meta,
    approve,
    reject,
    markReceived,
    complete,
    changeFilter,
    setPage,
  };
}
