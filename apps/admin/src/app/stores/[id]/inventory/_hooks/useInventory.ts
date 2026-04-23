'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../../../../../lib/api';
import { useDebouncedValue } from '../../../../../hooks/useDebouncedValue';
import type {
  HistoryItem,
  InventoryStats,
  ProductInventory,
  StockFilter,
} from '../_components/types';

/**
 * Centralizes data loading for the inventory page: stats, product list,
 * history, and low-stock alerts. Re-fetches the product list when the
 * stock filter or debounced search term changes.
 */
export function useInventory(storeId: string) {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<InventoryStats | null>(null);
  const [products, setProducts] = useState<ProductInventory[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [alerts, setAlerts] = useState<ProductInventory[]>([]);

  const [stockFilter, setStockFilter] = useState<StockFilter>('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);

  const fetchStats = useCallback(async () => {
    const { data } = await apiGet<{ stats: InventoryStats }>(
      `/api/v1/stores/${storeId}/inventory/stats`
    );
    if (data) {
      setStats(data.stats || null);
    }
  }, [storeId]);

  const fetchProducts = useCallback(async () => {
    const qs = new URLSearchParams();
    if (stockFilter !== 'all') qs.set('stockFilter', stockFilter);
    if (debouncedSearch) qs.set('search', debouncedSearch);
    qs.set('sortBy', 'inventory');
    qs.set('sortOrder', 'asc');

    const { data } = await apiGet<{ products: ProductInventory[] }>(
      `/api/v1/stores/${storeId}/inventory/products?${qs}`
    );
    if (data) {
      setProducts(data.products || []);
    }
  }, [storeId, stockFilter, debouncedSearch]);

  const fetchHistory = useCallback(async () => {
    const { data } = await apiGet<{ history: HistoryItem[] }>(
      `/api/v1/stores/${storeId}/inventory/history?limit=50`
    );
    if (data) {
      setHistory(data.history || []);
    }
  }, [storeId]);

  const fetchAlerts = useCallback(async () => {
    const { data } = await apiGet<{ alerts: ProductInventory[] }>(
      `/api/v1/stores/${storeId}/inventory/alerts`
    );
    if (data) {
      setAlerts(data.alerts || []);
    }
  }, [storeId]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchStats(), fetchProducts(), fetchHistory(), fetchAlerts()]);
    setLoading(false);
  }, [fetchStats, fetchProducts, fetchHistory, fetchAlerts]);

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  useEffect(() => {
    if (!loading) {
      fetchProducts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stockFilter, debouncedSearch]);

  return {
    loading,
    stats,
    products,
    history,
    alerts,
    stockFilter,
    setStockFilter,
    search,
    setSearch,
    fetchStats,
    fetchProducts,
    fetchHistory,
    fetchAlerts,
  };
}
