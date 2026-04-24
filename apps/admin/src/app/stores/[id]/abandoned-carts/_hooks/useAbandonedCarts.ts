'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@force/ui';
import { useT } from '@/i18n/useT';
import { apiGet, apiPut } from '../../../../../lib/api';
import { DEFAULT_CONFIG } from '../_components/types';
import type {
  AbandonedCartConfig,
  AbandonedCartRecord,
  AbandonedCartStats,
  ListMeta,
} from '../_components/types';

interface UseAbandonedCartsArgs {
  storeId: string;
  enabled: boolean;
}

/**
 * Encapsulates the three fetches (stats, config, carts list) plus the config
 * save mutation, and keeps the page state machine out of the render tree.
 * `enabled` gates all fetches — the hook stays quiet when the feature flag is
 * off so we don't hit the API for every mount. Owns its save toasts via
 * useToast + useT so the page doesn't need to pass a messages object.
 */
export function useAbandonedCarts({ storeId, enabled }: UseAbandonedCartsArgs) {
  const toast = useToast();
  const tMessages = useT('abandonedCarts.messages');
  const [stats, setStats] = useState<AbandonedCartStats | null>(null);
  const [config, setConfig] = useState<AbandonedCartConfig>(DEFAULT_CONFIG);
  const [records, setRecords] = useState<AbandonedCartRecord[]>([]);
  const [meta, setMeta] = useState<ListMeta>({ total: 0, page: 1, limit: 20, totalPages: 1 });
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);

  const fetchStats = useCallback(async () => {
    const { data } = await apiGet<{ stats: AbandonedCartStats }>(
      `/api/v1/stores/${storeId}/abandoned-carts/stats`
    );
    if (data?.stats) setStats(data.stats);
  }, [storeId]);

  const fetchConfig = useCallback(async () => {
    const { data } = await apiGet<{ config: AbandonedCartConfig }>(
      `/api/v1/stores/${storeId}/abandoned-carts/config`
    );
    if (data?.config) setConfig({ ...DEFAULT_CONFIG, ...data.config });
  }, [storeId]);

  const fetchCarts = useCallback(async () => {
    const qs = new URLSearchParams({ page: String(page), limit: '20' });
    if (statusFilter !== 'all') qs.set('status', statusFilter);
    const { data } = await apiGet<{ records: AbandonedCartRecord[]; meta: ListMeta }>(
      `/api/v1/stores/${storeId}/abandoned-carts?${qs}`
    );
    if (data) {
      setRecords(data.records || []);
      setMeta(data.meta || { total: 0, page: 1, limit: 20, totalPages: 1 });
    }
  }, [storeId, page, statusFilter]);

  // Initial load: fetch everything once per store when feature is enabled.
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchStats(), fetchConfig(), fetchCarts()]).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, enabled]);

  // Re-fetch just the list when the filter or page changes post-load.
  useEffect(() => {
    if (!enabled || loading) return;
    fetchCarts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, statusFilter]);

  const patchConfig = useCallback((patch: Partial<AbandonedCartConfig>) => {
    setConfig(prev => ({ ...prev, ...patch }));
  }, []);

  const saveConfig = useCallback(async () => {
    setSavingConfig(true);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/abandoned-carts/config`, config);
      if (!error) {
        toast.success(tMessages('saveSuccessTitle'), tMessages('saveSuccessBody'));
      } else {
        toast.error(tMessages('saveErrorTitle'), error.message || tMessages('saveErrorBody'));
      }
    } catch (err) {
      console.error('Failed to save config:', err);
      toast.error(tMessages('saveErrorTitle'), tMessages('saveErrorBody'));
    } finally {
      setSavingConfig(false);
    }
  }, [storeId, config, toast, tMessages]);

  const changeStatusFilter = useCallback((value: string) => {
    setStatusFilter(value);
    setPage(1);
  }, []);

  return {
    stats,
    config,
    records,
    meta,
    statusFilter,
    page,
    loading,
    savingConfig,
    patchConfig,
    saveConfig,
    setPage,
    changeStatusFilter,
  };
}
