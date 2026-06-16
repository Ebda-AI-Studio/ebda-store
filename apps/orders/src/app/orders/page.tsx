'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet } from '@/lib/api';
import {
  STATUS_FILTERS,
  clientFilterMatches,
  filterToApiStatus,
  type Order,
  type Pagination,
  type StatusFilter,
} from '@/lib/orders';
import { useStore } from '@/contexts/StoreContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/lib/auth';
import { AppHeader } from '@/components/AppHeader';
import { OrderCard } from '@/components/OrderCard';
import { InstallPrompt } from '@/components/InstallPrompt';
import { EnableNotifications } from '@/components/EnableNotifications';
import { NewOrderWatcher } from '@/components/NewOrderWatcher';

const POLL_MS = 30_000;

export default function OrdersListPage() {
  const { selectedStoreId, isLoading: storeLoading } = useStore();
  const { isLoading: authLoading, isAuthenticated } = useAuth();
  const { t } = useLanguage();

  const [orders, setOrders] = useState<Order[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 0,
  });
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pageRef = useRef(1);

  const fetchOrders = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!selectedStoreId) return;
      if (!opts?.silent) setIsLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({
          page: String(pageRef.current),
          limit: String(pagination.limit),
        });
        const apiStatus = filterToApiStatus(filter);
        if (apiStatus) qs.set('status', apiStatus);

        // Same { orders, meta } envelope OrderService.list emits. Accept
        // `pagination` too, defensively, matching the admin list.
        const { data, error: apiError } = await apiGet<{
          orders: Order[];
          meta?: Pagination;
          pagination?: Pagination;
        }>(`/api/v1/stores/${selectedStoreId}/orders?${qs}`);

        if (apiError) {
          setError(apiError.message || t.orders.error);
        } else {
          setOrders(data?.orders ?? []);
          const meta = data?.meta ?? data?.pagination;
          if (meta) setPagination(prev => ({ ...prev, ...meta }));
        }
      } catch {
        setError(t.orders.error);
      } finally {
        setIsLoading(false);
      }
    },
    [selectedStoreId, pagination.limit, filter, t.orders.error]
  );

  // Reset to page 1 when store or filter changes.
  useEffect(() => {
    pageRef.current = 1;
    setPagination(prev => ({ ...prev, page: 1 }));
  }, [selectedStoreId, filter]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  // Background poll for new orders (foreground only — paused when tab hidden).
  useEffect(() => {
    if (!selectedStoreId) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') fetchOrders({ silent: true });
    }, POLL_MS);
    return () => clearInterval(id);
  }, [selectedStoreId, fetchOrders]);

  const visibleOrders = useMemo(
    () => orders.filter(o => clientFilterMatches(o, filter)),
    [orders, filter]
  );

  // Newest pending order drives the new-order alert.
  const latestPendingId = useMemo(() => {
    const pending = orders.filter(o => o.status === 'pending');
    return pending.length > 0 ? pending[0].id : null;
  }, [orders]);

  const goToPage = (next: number) => {
    pageRef.current = next;
    setPagination(prev => ({ ...prev, page: next }));
    fetchOrders();
  };

  const blocked = storeLoading || authLoading || !isAuthenticated;

  return (
    <div className="min-h-dvh pb-[calc(env(safe-area-inset-bottom,0px)+1.5rem)]">
      <AppHeader />
      <NewOrderWatcher latestPendingId={latestPendingId} />

      <main className="mx-auto max-w-2xl px-4 pt-4">
        <InstallPrompt />
        <EnableNotifications />

        {/* Status filter chips */}
        <div className="-mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-1">
          {STATUS_FILTERS.map(f => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`inline-flex h-9 shrink-0 items-center rounded-full border px-4 text-sm font-semibold transition-colors ${
                filter === f
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-card text-foreground'
              }`}
            >
              {t.filters[f]}
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-4 flex items-center justify-between rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <span>{error}</span>
            <button type="button" onClick={() => fetchOrders()} className="font-semibold underline">
              {t.orders.retry}
            </button>
          </div>
        )}

        {(isLoading || blocked) && (
          <div className="space-y-3">
            {[0, 1, 2, 3].map(i => (
              <div
                key={i}
                className="h-24 animate-pulse rounded-2xl border border-border bg-card"
              />
            ))}
          </div>
        )}

        {!isLoading && !blocked && visibleOrders.length === 0 && (
          <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            {filter === 'all' ? t.orders.empty : t.orders.emptyFiltered}
          </div>
        )}

        {!isLoading && !blocked && visibleOrders.length > 0 && (
          <div className="space-y-3">
            {visibleOrders.map(order => (
              <OrderCard key={order.id} order={order} storeId={selectedStoreId!} />
            ))}
          </div>
        )}

        {/* Pagination */}
        {pagination.totalPages > 1 && (
          <div className="mt-5 flex items-center justify-between">
            <button
              type="button"
              disabled={pagination.page <= 1}
              onClick={() => goToPage(pagination.page - 1)}
              className="inline-flex h-10 items-center rounded-full border border-border bg-card px-4 text-sm font-medium disabled:opacity-40"
            >
              ‹
            </button>
            <span className="text-sm text-muted-foreground">
              {pagination.page} / {pagination.totalPages}
            </span>
            <button
              type="button"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => goToPage(pagination.page + 1)}
              className="inline-flex h-10 items-center rounded-full border border-border bg-card px-4 text-sm font-medium disabled:opacity-40"
            >
              ›
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
