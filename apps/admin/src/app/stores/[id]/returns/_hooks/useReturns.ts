'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../../../../../lib/api';
import type { ListMeta, ReturnFilter, ReturnRecord, ReturnsStats } from '../_components/types';

interface ReturnsActionMessages {
  approveSuccessTitle: string;
  approveSuccessBody: string;
  approveErrorTitle: string;
  approveErrorBody: string;
  rejectPrompt: string;
  rejectSuccessTitle: string;
  rejectSuccessBody: string;
  rejectErrorTitle: string;
  rejectErrorBody: string;
  receivedSuccessTitle: string;
  receivedSuccessBody: string;
  receivedErrorTitle: string;
  receivedErrorBody: string;
  completePrompt: string;
  completeSuccessTitle: string;
  completeSuccessBody: string;
  completeErrorTitle: string;
  completeErrorBody: string;
}

interface UseReturnsArgs {
  storeId: string;
  messages: ReturnsActionMessages;
  onSuccess: (title: string, body: string) => void;
  onError: (title: string, body: string) => void;
}

/**
 * Encapsulates the returns list + stats fetches and the four lifecycle
 * mutations (approve, reject, mark received, complete). Keeps the page
 * component free of state plumbing and toast wiring.
 */
export function useReturns({ storeId, messages, onSuccess, onError }: UseReturnsArgs) {
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
          onError(messages.approveErrorTitle, messages.approveErrorBody);
          return false;
        }
        onSuccess(messages.approveSuccessTitle, messages.approveSuccessBody);
        refreshAll();
        return true;
      } catch (error) {
        console.error('Failed to approve return:', error);
        onError(messages.approveErrorTitle, messages.approveErrorBody);
        return false;
      }
    },
    [storeId, onError, onSuccess, messages, refreshAll]
  );

  const reject = useCallback(
    async (returnId: string) => {
      const reason = prompt(messages.rejectPrompt);
      if (!reason) return false;
      try {
        const { error } = await apiPost(
          `/api/v1/stores/${storeId}/returns/admin/${returnId}/reject`,
          { reason }
        );
        if (error) {
          onError(messages.rejectErrorTitle, messages.rejectErrorBody);
          return false;
        }
        onSuccess(messages.rejectSuccessTitle, messages.rejectSuccessBody);
        refreshAll();
        return true;
      } catch (error) {
        console.error('Failed to reject return:', error);
        onError(messages.rejectErrorTitle, messages.rejectErrorBody);
        return false;
      }
    },
    [storeId, onError, onSuccess, messages, refreshAll]
  );

  const markReceived = useCallback(
    async (returnId: string) => {
      try {
        const { error } = await apiPost(
          `/api/v1/stores/${storeId}/returns/admin/${returnId}/received`
        );
        if (error) {
          onError(messages.receivedErrorTitle, messages.receivedErrorBody);
          return false;
        }
        onSuccess(messages.receivedSuccessTitle, messages.receivedSuccessBody);
        refreshAll();
        return true;
      } catch (error) {
        console.error('Failed to mark as received:', error);
        onError(messages.receivedErrorTitle, messages.receivedErrorBody);
        return false;
      }
    },
    [storeId, onError, onSuccess, messages, refreshAll]
  );

  const complete = useCallback(
    async (returnId: string) => {
      const refundMethod = prompt(messages.completePrompt);
      if (!refundMethod) return false;
      try {
        const { error } = await apiPost(
          `/api/v1/stores/${storeId}/returns/admin/${returnId}/complete`,
          { refundMethod }
        );
        if (error) {
          onError(messages.completeErrorTitle, messages.completeErrorBody);
          return false;
        }
        onSuccess(messages.completeSuccessTitle, messages.completeSuccessBody);
        refreshAll();
        return true;
      } catch (error) {
        console.error('Failed to complete return:', error);
        onError(messages.completeErrorTitle, messages.completeErrorBody);
        return false;
      }
    },
    [storeId, onError, onSuccess, messages, refreshAll]
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
