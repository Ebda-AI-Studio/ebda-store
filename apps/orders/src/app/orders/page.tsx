'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import {
  STATUS_FILTERS,
  clientFilterMatches,
  filterToApiStatus,
  type Order,
  type Pagination,
  type StatusFilter,
} from '@/lib/orders';
import { can } from '@/lib/permissions';
import { useStore } from '@/contexts/StoreContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/contexts/ToastContext';
import { AppHeader } from '@/components/AppHeader';
import { OrderCard } from '@/components/OrderCard';
import { InstallPrompt } from '@/components/InstallPrompt';
import { EnableNotifications } from '@/components/EnableNotifications';
import { NewOrderWatcher } from '@/components/NewOrderWatcher';
import { reportRangeParams, searchQueryHeaders } from '@ebda/shared';

const POLL_MS = 30_000;
const PER_PAGE_OPTIONS = [10, 25, 50] as const;
type PerPageOption = (typeof PER_PAGE_OPTIONS)[number];

type DatePreset = 'today' | 'last7' | 'last30' | 'custom';

interface CustomRange {
  from: string;
  to: string;
}

function toDateStr(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function resolvePreset(preset: DatePreset, custom?: CustomRange): { from: string; to: string } {
  const now = new Date();
  if (preset === 'today') {
    const s = toDateStr(now);
    return { from: s, to: s };
  }
  if (preset === 'last7') {
    const start = new Date(now);
    start.setDate(start.getDate() - 6);
    return { from: toDateStr(start), to: toDateStr(now) };
  }
  if (preset === 'last30') {
    const start = new Date(now);
    start.setDate(start.getDate() - 29);
    return { from: toDateStr(start), to: toDateStr(now) };
  }
  // custom
  if (custom?.from && custom?.to) return { from: custom.from, to: custom.to };
  const start = new Date(now);
  start.setDate(start.getDate() - 29);
  return { from: toDateStr(start), to: toDateStr(now) };
}

// Terminal statuses can never be marked paid → never selectable for the bulk
// mark-paid action. Used by both selectableIds (select-all + "N selected" counts)
// and the per-card checkbox, so excluding here hides the checkbox everywhere.
const TERMINAL_ORDER_STATUSES = ['cancelled', 'refunded'];

function isCodUnpaid(order: Order): boolean {
  if (TERMINAL_ORDER_STATUSES.includes(order.status)) return false;
  if (order.paymentStatus === 'paid') return false;
  const payments = order.payments ?? [];
  if (payments.length === 0) return true; // no payments recorded = COD
  return payments.some(p => p.provider === 'cod');
}

function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? `{${key}}`));
}

export default function OrdersListPage() {
  const { selectedStoreId, isLoading: storeLoading } = useStore();
  const { isLoading: authLoading, isAuthenticated, user } = useAuth();
  const { t, dir } = useLanguage();
  const { notify } = useToast();

  // ── Per-page preference (persisted per store) ────────────────────────────
  const limitStorageKey = selectedStoreId ? `orders.perPage.${selectedStoreId}` : null;
  const initialLimit = ((): PerPageOption => {
    if (typeof window === 'undefined' || !limitStorageKey) return 25;
    const stored = window.localStorage.getItem(limitStorageKey);
    const parsed = stored ? parseInt(stored, 10) : NaN;
    return (PER_PAGE_OPTIONS as readonly number[]).includes(parsed)
      ? (parsed as PerPageOption)
      : 25;
  })();

  // ── Core list state ───────────────────────────────────────────────────────
  const [orders, setOrders] = useState<Order[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: initialLimit,
    total: 0,
    totalPages: 0,
  });
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pageRef = useRef(1);

  // ── Date-range state ──────────────────────────────────────────────────────
  const [datePreset, setDatePreset] = useState<DatePreset>('last30');
  const [customRange, setCustomRange] = useState<CustomRange>({ from: '', to: '' });
  const [showCustom, setShowCustom] = useState(false);
  const [pendingCustom, setPendingCustom] = useState<CustomRange>({ from: '', to: '' });

  // ── Search state ──────────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  // The 404's "Search orders" opens this list with the box focused (the term is typed here, never put in a URL).
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('focus') === 'search') {
      searchInputRef.current?.focus();
    }
  }, []);
  // Search runs server-side over every order (it used to filter only the
  // fetched page), so it is debounced rather than sent per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);
  // Latest-request-wins: a filter change, a page change and the background
  // poll overlap; only the newest response may paint the list.
  const requestSeq = useRef(0);

  // ── Bulk selection state ──────────────────────────────────────────────────
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);

  const canManage = can(user, 'orders:manage');

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchOrders = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!selectedStoreId) return;
      const mine = ++requestSeq.current;
      const isLatest = () => mine === requestSeq.current;
      if (!opts?.silent) setIsLoading(true);
      setError(null);
      try {
        const resolved = resolvePreset(datePreset, customRange);
        // The shared report-range contract: the picked days as instants in
        // the viewer's timezone. The date-only `from`/`to` this sent were
        // read by the API as UTC days (an Egypt "today" started 3h late).
        const [fy, fm, fd] = resolved.from.split('-').map(Number);
        const [ty, tm, td] = resolved.to.split('-').map(Number);
        const qs = new URLSearchParams({
          page: String(pageRef.current),
          limit: String(pagination.limit),
          ...reportRangeParams({
            startDate: new Date(fy, fm - 1, fd, 0, 0, 0, 0),
            endDate: new Date(ty, tm - 1, td, 23, 59, 59, 999),
          }),
          // Orders PWA is a fulfillment tool — staff should only see orders
          // that are actionable: COD orders (any status) and confirmed/paid
          // online orders. Unconfirmed online orders (pending + unpaid, customer
          // hasn't paid yet) are not fulfillable and clutter the list. The API
          // filters these out server-side when confirmedOnly=1 is present.
          confirmedOnly: '1',
        });
        const apiStatus = filterToApiStatus(filter);
        if (apiStatus) qs.set('status', apiStatus);
        // `paid` is a payment-status filter; applied server-side so it spans
        // every page (it used to refine only the fetched page).
        if (filter === 'paid') qs.set('paymentStatus', 'paid');

        const { data, error: apiError } = await apiGet<{
          orders: Order[];
          meta?: Pagination;
          pagination?: Pagination;
        }>(`/api/v1/stores/${selectedStoreId}/orders?${qs}`, searchQueryHeaders(debouncedSearch));
        if (!isLatest()) return;

        if (apiError) {
          setError(apiError.message || t.orders.error);
        } else {
          setOrders(data?.orders ?? []);
          const meta = data?.meta ?? data?.pagination;
          if (meta) setPagination(prev => ({ ...prev, ...meta }));
        }
      } catch {
        if (isLatest()) setError(t.orders.error);
      } finally {
        if (isLatest()) setIsLoading(false);
      }
    },
    [
      selectedStoreId,
      pagination.limit,
      filter,
      datePreset,
      customRange,
      debouncedSearch,
      t.orders.error,
    ]
  );

  // Reset to page 1 when store, filter, date range or search changes.
  useEffect(() => {
    pageRef.current = 1;
    setPagination(prev => ({ ...prev, page: 1 }));
    setSelectedOrders(new Set());
  }, [selectedStoreId, filter, datePreset, customRange, debouncedSearch]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  // Background poll.
  useEffect(() => {
    if (!selectedStoreId) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') fetchOrders({ silent: true });
    }, POLL_MS);
    return () => clearInterval(id);
  }, [selectedStoreId, fetchOrders]);

  // ── Derived filtered + searched list ──────────────────────────────────────
  const visibleOrders = useMemo(() => {
    // Status, payment status and search are all applied by the API now; a
    // second client-side search here would drop the email/phone matches the
    // server returned.
    const list = orders.filter(o => clientFilterMatches(o, filter));
    return list;
  }, [orders, filter]);

  // Newest order id drives the in-app new-order alert (NewOrderWatcher).
  //
  // With the confirmed-only filter active, pending unconfirmed online orders
  // are excluded from the list — so watching for `status === 'pending'` would
  // never fire. Instead we watch the newest order in the response (orders are
  // already sorted newest-first by the API). When a new order appears at the
  // top, NewOrderWatcher beeps + toasts.
  //
  // COD orders arrive as status=pending and ARE included (no online Payment row).
  // Confirmed/paid online orders arrive as status=confirmed. Both are "new" to
  // a fulfillment operator and should trigger the alert.
  const latestOrderId = useMemo(() => {
    return orders.length > 0 ? orders[0].id : null;
  }, [orders]);

  // ── Pagination helpers ────────────────────────────────────────────────────
  const goToPage = (next: number) => {
    pageRef.current = next;
    setPagination(prev => ({ ...prev, page: next }));
    fetchOrders();
  };

  // ── Bulk mark-paid ────────────────────────────────────────────────────────
  const selectableIds = useMemo(
    () => new Set(visibleOrders.filter(isCodUnpaid).map(o => o.id)),
    [visibleOrders]
  );

  const allSelectableChecked =
    selectableIds.size > 0 && [...selectableIds].every(id => selectedOrders.has(id));

  const toggleOrder = (id: string, checked: boolean) => {
    setSelectedOrders(prev => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleAllSelectable = (checked: boolean) => {
    setSelectedOrders(prev => {
      const next = new Set(prev);
      for (const id of selectableIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const executeBulkMarkPaid = async () => {
    const ids = Array.from(selectedOrders);
    if (ids.length === 0) return;
    setIsBulkProcessing(true);
    try {
      const { data, error: apiError } = await apiPost<{ updated: number; skipped: number }>(
        `/api/v1/stores/${selectedStoreId}/orders/bulk-mark-paid`,
        { orderIds: ids.slice(0, 50) }
      );
      if (!apiError && data) {
        notify(interpolate(t.bulk.markPaidSuccess, { count: data.updated }), 'success');
        const idSet = new Set(ids);
        setOrders(prev =>
          prev.map(o =>
            idSet.has(o.id)
              ? {
                  ...o,
                  paymentStatus: 'paid',
                  status: 'confirmed',
                  payments: o.payments?.map(p =>
                    p.provider === 'cod' ? { ...p, status: 'completed' } : p
                  ),
                }
              : o
          )
        );
        setSelectedOrders(new Set());
        fetchOrders();
      } else {
        notify(apiError?.message || t.bulk.markPaidError, 'error');
      }
    } catch {
      notify(t.bulk.markPaidError, 'error');
    } finally {
      setIsBulkProcessing(false);
      setBulkConfirmOpen(false);
    }
  };

  // ── Per-page change ───────────────────────────────────────────────────────
  const handleLimitChange = (limit: PerPageOption) => {
    if (limitStorageKey) window.localStorage.setItem(limitStorageKey, String(limit));
    pageRef.current = 1;
    setPagination(prev => ({ ...prev, limit, page: 1 }));
  };

  // ── Date preset buttons ───────────────────────────────────────────────────
  const DATE_PRESETS: { key: DatePreset; label: string }[] = [
    { key: 'today', label: t.dateRange.today },
    { key: 'last7', label: t.dateRange.last7 },
    { key: 'last30', label: t.dateRange.last30 },
    { key: 'custom', label: t.dateRange.custom },
  ];

  const blocked = storeLoading || authLoading || !isAuthenticated;

  return (
    <div className="min-h-dvh pb-[calc(env(safe-area-inset-bottom,0px)+1.5rem)]">
      <AppHeader />
      <NewOrderWatcher latestOrderId={latestOrderId} />

      <main className="mx-auto max-w-2xl px-4 pt-4">
        <InstallPrompt />
        <EnableNotifications />

        {/* ── Date-range presets ── */}
        <div className="mb-3 -mx-1 flex gap-2 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {DATE_PRESETS.map(p => (
            <button
              key={p.key}
              type="button"
              onClick={() => {
                if (p.key === 'custom') {
                  setShowCustom(v => !v);
                } else {
                  setDatePreset(p.key);
                  setShowCustom(false);
                }
              }}
              className={`inline-flex h-9 shrink-0 items-center rounded-full border px-3 text-xs font-semibold transition-colors active:opacity-80 ${
                datePreset === p.key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-card text-foreground'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Custom date-range picker (shown when custom preset is active or toggled) */}
        {(showCustom || datePreset === 'custom') && (
          <div
            className="mb-3 flex flex-wrap items-end gap-3 rounded-2xl border border-border bg-card p-3"
            dir={dir}
          >
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">
                {t.dateRange.from}
              </label>
              <input
                type="date"
                value={pendingCustom.from}
                onChange={e => setPendingCustom(prev => ({ ...prev, from: e.target.value }))}
                className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">{t.dateRange.to}</label>
              <input
                type="date"
                value={pendingCustom.to}
                onChange={e => setPendingCustom(prev => ({ ...prev, to: e.target.value }))}
                className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground"
              />
            </div>
            <button
              type="button"
              disabled={!pendingCustom.from || !pendingCustom.to}
              onClick={() => {
                setCustomRange(pendingCustom);
                setDatePreset('custom');
                setShowCustom(false);
              }}
              className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-40 active:opacity-80"
            >
              {t.dateRange.apply}
            </button>
          </div>
        )}

        {/* ── Search box ── */}
        <div className="mb-3 relative">
          <span
            className="absolute top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
            style={{ [dir === 'rtl' ? 'right' : 'left']: '0.875rem' }}
            aria-hidden="true"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-4.35-4.35M17 11A6 6 0 111 11a6 6 0 0116 0z"
              />
            </svg>
          </span>
          <input
            ref={searchInputRef}
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t.search.placeholder}
            className="w-full h-11 rounded-2xl border border-border bg-card text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            style={{
              paddingInlineStart: '2.5rem',
              paddingInlineEnd: search ? '2.5rem' : '1rem',
            }}
          />
          {search && (
            <button
              type="button"
              aria-label={t.search.clear}
              onClick={() => setSearch('')}
              className="absolute top-1/2 -translate-y-1/2 text-muted-foreground active:text-foreground"
              style={{ [dir === 'rtl' ? 'left' : 'right']: '0.875rem' }}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* ── Filter row + manual refresh ── */}
        <div className="mb-4 flex items-center gap-2">
          {/* Status filter chips */}
          <div className="-mx-1 flex flex-1 gap-2 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {STATUS_FILTERS.map(f => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`inline-flex h-11 min-w-[44px] shrink-0 items-center rounded-full border px-4 text-sm font-semibold transition-colors active:opacity-80 ${
                  filter === f
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-foreground'
                }`}
              >
                {t.filters[f]}
              </button>
            ))}
          </div>
          {/* Manual refresh */}
          <button
            type="button"
            onClick={() => fetchOrders()}
            aria-label={t.orders.refresh}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground active:bg-muted/60"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>
        </div>

        {/* ── Bulk confirm dialog ── */}
        {bulkConfirmOpen && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
            <div className="w-full max-w-sm rounded-t-3xl sm:rounded-3xl border border-border bg-card p-5 shadow-xl">
              <p className="text-sm font-semibold text-foreground">
                {interpolate(t.bulk.markPaidConfirm, { count: selectedOrders.size })}
              </p>
              <div className="mt-4 flex gap-3">
                <button
                  type="button"
                  disabled={isBulkProcessing}
                  onClick={executeBulkMarkPaid}
                  className="flex-1 inline-flex h-11 items-center justify-center rounded-xl bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-50 active:opacity-80"
                >
                  {isBulkProcessing ? t.bulk.processing : t.bulk.markPaid}
                </button>
                <button
                  type="button"
                  disabled={isBulkProcessing}
                  onClick={() => setBulkConfirmOpen(false)}
                  className="flex-1 inline-flex h-11 items-center justify-center rounded-xl border border-border bg-card text-sm font-semibold text-foreground disabled:opacity-50 active:bg-muted/60"
                >
                  {t.detail.actions.cancel}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Bulk action bar ── */}
        {canManage && selectedOrders.size > 0 && (
          <div className="mb-4 flex items-center gap-3 rounded-2xl border border-primary/30 bg-primary/5 px-4 py-3">
            <span className="flex-1 text-sm font-medium text-foreground">
              {interpolate(t.bulk.selected, { count: selectedOrders.size })}
            </span>
            <button
              type="button"
              disabled={isBulkProcessing}
              onClick={() => setBulkConfirmOpen(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-50 active:opacity-80"
            >
              {isBulkProcessing ? t.bulk.processing : t.bulk.markPaid}
            </button>
            <button
              type="button"
              onClick={() => setSelectedOrders(new Set())}
              className="text-xs text-muted-foreground active:text-foreground"
            >
              {t.bulk.clearSelection}
            </button>
          </div>
        )}

        {error && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive-ink">
            <span className="min-w-0">{error}</span>
            <button
              type="button"
              onClick={() => fetchOrders()}
              className="inline-flex h-11 min-w-[44px] shrink-0 items-center rounded-full border border-destructive/30 px-4 text-sm font-semibold text-destructive-ink active:bg-destructive/10"
            >
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
          <div className="flex flex-col items-center rounded-2xl border border-border bg-card px-6 py-12 text-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="mb-3 h-10 w-10 text-muted-foreground/50"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
              />
            </svg>
            <p className="text-sm font-medium text-muted-foreground">
              {filter === 'all' && !search ? t.orders.empty : t.orders.emptyFiltered}
            </p>
            {(filter !== 'all' || search) && (
              <button
                type="button"
                onClick={() => {
                  setFilter('all');
                  setSearch('');
                }}
                className="mt-4 inline-flex h-11 min-w-[44px] items-center rounded-full border border-border bg-card px-4 text-sm font-medium text-foreground active:bg-muted/60"
              >
                {t.filters.all}
              </button>
            )}
          </div>
        )}

        {!isLoading && !blocked && visibleOrders.length > 0 && (
          <>
            {/* Select-all row when there are selectable (COD/unpaid) orders */}
            {canManage && selectableIds.size > 0 && (
              <div className="mb-2 flex items-center gap-2 px-1">
                <input
                  type="checkbox"
                  id="select-all"
                  checked={allSelectableChecked}
                  onChange={e => toggleAllSelectable(e.target.checked)}
                  className="h-5 w-5 rounded border-border accent-primary"
                />
                <label htmlFor="select-all" className="text-xs text-muted-foreground select-none">
                  {allSelectableChecked
                    ? t.bulk.clearSelection
                    : interpolate(t.bulk.selected, { count: selectableIds.size })}
                </label>
              </div>
            )}

            <div className="space-y-3">
              {visibleOrders.map(order => {
                const selectable = canManage && isCodUnpaid(order);
                const isChecked = selectedOrders.has(order.id);
                return (
                  <div key={order.id} className="relative">
                    {selectable && (
                      <button
                        type="button"
                        aria-label={isChecked ? t.bulk.clearSelection : t.bulk.markPaid}
                        onClick={() => toggleOrder(order.id, !isChecked)}
                        className="absolute z-10 flex h-8 w-8 items-center justify-center active:scale-95"
                        style={{
                          top: '0.75rem',
                          [dir === 'rtl' ? 'left' : 'right']: '0.75rem',
                        }}
                      >
                        <span
                          className={`flex h-5 w-5 items-center justify-center rounded border-2 transition-colors ${
                            isChecked ? 'border-primary bg-primary' : 'border-border bg-card'
                          }`}
                        >
                          {isChecked && (
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              className="h-3 w-3 text-primary-foreground"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={3}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M5 13l4 4L19 7"
                              />
                            </svg>
                          )}
                        </span>
                      </button>
                    )}
                    <OrderCard
                      order={order}
                      storeId={selectedStoreId!}
                      canManage={canManage}
                      onChanged={() => void fetchOrders({ silent: true })}
                    />
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* ── Pagination + per-page ── */}
        {!isLoading && !blocked && (pagination.totalPages > 1 || pagination.total > 10) && (
          <div className="mt-5 flex items-center gap-3">
            <button
              type="button"
              disabled={pagination.page <= 1}
              onClick={() => goToPage(pagination.page - 1)}
              className="inline-flex h-11 min-w-[44px] items-center rounded-full border border-border bg-card px-5 text-sm font-medium disabled:opacity-40 active:bg-muted/60"
            >
              {dir === 'rtl' ? '›' : '‹'}
            </button>
            <span className="flex-1 text-center text-sm text-muted-foreground">
              {pagination.page} / {pagination.totalPages}
            </span>
            <button
              type="button"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => goToPage(pagination.page + 1)}
              className="inline-flex h-11 min-w-[44px] items-center rounded-full border border-border bg-card px-5 text-sm font-medium disabled:opacity-40 active:bg-muted/60"
            >
              {dir === 'rtl' ? '‹' : '›'}
            </button>

            {/* Per-page selector */}
            <div className="flex items-center gap-1">
              {PER_PAGE_OPTIONS.map(n => (
                <button
                  key={n}
                  type="button"
                  onClick={() => handleLimitChange(n)}
                  className={`inline-flex h-9 w-9 items-center justify-center rounded-xl border text-xs font-semibold transition-colors active:opacity-80 ${
                    pagination.limit === n
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-card text-muted-foreground'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
