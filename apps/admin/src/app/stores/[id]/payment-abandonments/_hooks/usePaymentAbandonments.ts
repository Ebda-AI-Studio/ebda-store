'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../../../../../lib/api';

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

  const fetchStats = useCallback(async () => {
    // apiGet already unwraps the { success, data } envelope, so `data` IS the
    // stats payload — do not unwrap a second time (the double-unwrap silently
    // dropped real rows; see fwb-apiget-double-unwrap).
    const { data } = await apiGet<AbandonmentStats>(
      `/api/v1/stores/${storeId}/payment-abandonments/stats`
    );
    if (data) setStats(data);
  }, [storeId]);

  const fetchList = useCallback(async () => {
    const qs = new URLSearchParams({ page: String(page), limit: '25' });
    if (dateFrom) qs.set('from', dateFrom);
    if (dateTo) qs.set('to', dateTo);
    const { data } = await apiGet<{ abandoners: AbandonmentRecord[]; meta: ListMeta }>(
      `/api/v1/stores/${storeId}/payment-abandonments?${qs}`
    );
    if (data) {
      setRecords(data.abandoners ?? []);
      setMeta(data.meta ?? { total: 0, page: 1, limit: 25, totalPages: 1 });
    }
  }, [storeId, page, dateFrom, dateTo]);

  // Initial load when feature is enabled
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchStats(), fetchList()]).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, enabled]);

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
    setPage,
    applyDateFilter,
  };
}
