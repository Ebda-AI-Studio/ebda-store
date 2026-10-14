'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@ebda/ui';
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
  const [guestCheckout, setGuestCheckout] = useState(false);
  const [config, setConfig] = useState<AbandonedCartConfig>(DEFAULT_CONFIG);
  const [records, setRecords] = useState<AbandonedCartRecord[]>([]);
  const [meta, setMeta] = useState<ListMeta>({ total: 0, page: 1, limit: 20, totalPages: 1 });
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);
  // First failed load's message (`''` = failed without one). A failed call
  // used to leave stats at 0 and the table empty — indistinguishable from
  // "no abandoned carts" (2026-09-30 audit, finding 8).
  const [error, setError] = useState<string | null>(null);
  const noteError = useCallback((e: { message?: string } | null | undefined) => {
    if (e) setError(prev => prev ?? e.message ?? '');
  }, []);

  const fetchStats = useCallback(async () => {
    const { data, error: apiError } = await apiGet<{
      stats: AbandonedCartStats;
      guestCheckout?: boolean;
    }>(`/api/v1/stores/${storeId}/abandoned-carts/stats`);
    noteError(apiError);
    if (data?.stats) setStats(data.stats);
    setGuestCheckout(data?.guestCheckout === true);
  }, [storeId, noteError]);

  const fetchConfig = useCallback(async () => {
    const { data, error: apiError } = await apiGet<{ config: AbandonedCartConfig }>(
      `/api/v1/stores/${storeId}/abandoned-carts/config`
    );
    noteError(apiError);
    if (data?.config) setConfig({ ...DEFAULT_CONFIG, ...data.config });
  }, [storeId, noteError]);

  const fetchCarts = useCallback(async () => {
    const qs = new URLSearchParams({ page: String(page), limit: '20' });
    if (statusFilter !== 'all') qs.set('status', statusFilter);
    const { data, error: apiError } = await apiGet<{
      records: AbandonedCartRecord[];
      meta: ListMeta;
    }>(`/api/v1/stores/${storeId}/abandoned-carts?${qs}`);
    noteError(apiError);
    if (data) {
      setRecords(data.records || []);
      setMeta(data.meta || { total: 0, page: 1, limit: 20, totalPages: 1 });
    }
  }, [storeId, page, statusFilter, noteError]);

  // Initial load: fetch everything once per store when feature is enabled.
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([fetchStats(), fetchConfig(), fetchCarts()]).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, enabled, reloadKey]);

  const retry = useCallback(() => setReloadKey(k => k + 1), []);

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
    guestCheckout,
    config,
    records,
    meta,
    statusFilter,
    page,
    loading,
    error,
    retry,
    savingConfig,
    patchConfig,
    saveConfig,
    setPage,
    changeStatusFilter,
  };
}
