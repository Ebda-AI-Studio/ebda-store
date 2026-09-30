'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../../../../../lib/api';
import { localDayRange, reportRangeParams } from '@force/shared';
import { useLatestRequest } from '../../../../../hooks/useLatestRequest';

export interface AbandonmentItem {
  id: string;
  productName: string;
  variantName: string | null;
  quantity: number;
  price: number;
  total: number;
}

export interface AbandonmentRecord {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  total: number;
  currency: string;
  abandonedAt: string;
  createdAt: string;
  customer: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    phoneMasked: string | null | undefined;
    emailMasked: string | null | undefined;
  } | null;
  guestContact: {
    firstName: string | null;
    lastName: string | null;
    phoneMasked: string | null | undefined;
    emailMasked: string | null | undefined;
  } | null;
  gateway: string | null;
  itemCount: number;
  items: AbandonmentItem[];
}

export interface AbandonmentStats {
  total: number;
  last7d: number;
  last30d: number;
  totalValue: number;
}

export interface ListMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface UsePaymentAbandonmentsArgs {
  storeId: string;
  enabled: boolean;
}

export function usePaymentAbandonments({ storeId, enabled }: UsePaymentAbandonmentsArgs) {
  const [stats, setStats] = useState<AbandonmentStats | null>(null);
  const [records, setRecords] = useState<AbandonmentRecord[]>([]);
  const [meta, setMeta] = useState<ListMeta>({ total: 0, page: 1, limit: 25, totalPages: 1 });
  const [page, setPage] = useState(1);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [loading, setLoading] = useState(true);
  // First failed load's message (`''` = failed without one). Ignoring it
  // rendered a 403/500 as zero stats + an empty table (2026-09-30 audit).
  const [error, setError] = useState<string | null>(null);
  const noteError = useCallback((e: { message?: string } | null | undefined) => {
    if (e) setError(prev => prev ?? e.message ?? '');
  }, []);

  const fetchStats = useCallback(async () => {
    // apiGet already unwraps the { success, data } envelope, so `data` IS the
    // stats payload — do not unwrap a second time (the double-unwrap silently
    // dropped real rows; see fwb-apiget-double-unwrap).
    const { data, error: apiError } = await apiGet<AbandonmentStats>(
      `/api/v1/stores/${storeId}/payment-abandonments/stats`
    );
    noteError(apiError);
    if (data) setStats(data);
  }, [storeId, noteError]);

  const beginRequest = useLatestRequest();
  const fetchList = useCallback(async () => {
    const isLatest = beginRequest();
    const qs = new URLSearchParams({ page: String(page), limit: '25' });
    // The picked days as instants in the viewer's timezone (shared contract).
    const range = localDayRange(dateFrom, dateTo);
    if (range) for (const [k, v] of Object.entries(reportRangeParams(range))) qs.set(k, v);
    const { data, error: apiError } = await apiGet<{
      abandoners: AbandonmentRecord[];
      meta: ListMeta;
    }>(`/api/v1/stores/${storeId}/payment-abandonments?${qs}`);
    if (!isLatest()) return;
    noteError(apiError);
    if (data) {
      setRecords(data.abandoners ?? []);
      setMeta(data.meta ?? { total: 0, page: 1, limit: 25, totalPages: 1 });
    }
  }, [storeId, page, dateFrom, dateTo, noteError, beginRequest]);

  // Initial load when feature is enabled
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([fetchStats(), fetchList()]).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, enabled, reloadKey]);

  const retry = useCallback(() => setReloadKey(k => k + 1), []);

  // Re-fetch list when page or date filter changes
  useEffect(() => {
    if (!enabled || loading) return;
    fetchList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, dateFrom, dateTo]);

  const applyDateFilter = useCallback((from: string, to: string) => {
    setDateFrom(from);
    setDateTo(to);
    setPage(1);
  }, []);

  return {
    stats,
    records,
    meta,
    page,
    dateFrom,
    dateTo,
    loading,
    error,
    retry,
    setPage,
    applyDateFilter,
  };
}
