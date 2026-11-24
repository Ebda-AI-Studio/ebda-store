'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '@ebda/ui';
import { buttonVariants } from '@/components/ui/Button';
import { RowActions } from '../../../../components/RowActions';
import { AdminLayout } from '../../../../components/AdminLayout';
import { PlanLimitNotice } from '@/components/billing/PlanLimitNotice';
import { DateRangePicker } from '../../../../components/DateRangePicker';
import { apiGet, apiPut, apiPost, apiFetch } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';
import { ManualRefundModal } from '../../../../components/ManualRefundModal';
import { useT } from '@/i18n/useT';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { exportFilename, moveSearchToHeader, orderListFilterParams } from '@ebda/shared';
import { OrdersFilters } from './_components/OrdersFilters';
import { OrdersBulkBar } from './_components/OrdersBulkBar';
import { OrdersTable } from './_components/OrdersTable';
import { OrdersPagination } from './_components/OrdersPagination';
import type { Order, Pagination, StatusFilter } from './_components/types';
import { ConfirmActionModal } from '../../../../components/ConfirmActionModal';
import type { Period, ResolvedDateRange } from '../analytics/_components/types';
import { resolveDateRange } from '../analytics/_components/types';
import { manualRefundBody, type ManualRefundInput } from './_components/manualRefundCopy';

type ConfirmType = 'markPaid' | 'bulkMarkPaid' | 'manualRefund';

interface ConfirmState {
  open: boolean;
  type: ConfirmType;
  orderId?: string;
  ids?: string[];
  /** manualRefund: the order the merchant picked "Refunded" for. */
  order?: Order;
}

export default function StoreOrdersPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('orders.list');
  const tConfirm = useT('orders.list.confirm');
  // Staff cannot record a refund (the API needs orders:refund): hide the option, not just fail it.
  const { user } = useAuth();
  const canRefund = !!user && user.role !== 'staff';
  // The API answers 403 to staff (customers:export is owner-only), so do not offer the button.
  const canExport = !!user && user.role !== 'staff';

  // Per-page preference is persisted per store so the user's choice survives
  // navigation. Falls back to 25 (admin default) when nothing is stored or the
  // stored value is malformed.
  const limitStorageKey = storeId ? `orders.perPage.${storeId}` : null;
  const initialLimit = (() => {
    if (typeof window === 'undefined' || !limitStorageKey) return 25;
    const stored = window.localStorage.getItem(limitStorageKey);
    const parsed = stored ? parseInt(stored, 10) : NaN;
    return [10, 25, 50, 100].includes(parsed) ? parsed : 25;
  })();

  const [period, setPeriod] = useState<Period>('last_30');
  const [customRange, setCustomRange] = useState<ResolvedDateRange | undefined>(undefined);

  const [orders, setOrders] = useState<Order[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: initialLimit,
    total: 0,
    totalPages: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmState>({
    open: false,
    type: 'markPaid',
  });
  const { success: toastSuccess, error: showError } = useToast();
  const [isExporting, setIsExporting] = useState(false);

  // Search runs server-side (it used to filter only the fetched page), so it
  // is debounced rather than sent per keystroke.
  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  /**
   * The list's filters as query params — the list AND the export send exactly
   * these, so the export is what is on screen. The range goes through the
   * shared report-range contract (viewer-local day boundaries as instants);
   * the old date-only `from`/`to` were read as UTC days by the API.
   */
  const filterParams = useCallback(
    (): URLSearchParams =>
      orderListFilterParams({
        range: resolveDateRange(period, customRange),
        status: statusFilter === 'all' ? undefined : statusFilter,
        search: debouncedSearch,
      }),
    [period, customRange, statusFilter, debouncedSearch]
  );

  // A new search starts from the first page.
  useEffect(() => {
    setPagination(prev => (prev.page === 1 ? prev : { ...prev, page: 1 }));
  }, [debouncedSearch]);

  // Overlapping list requests (a filter or period change mid-flight) resolve
  // in either order; only the newest may write (#2234 class).
  const beginRequest = useLatestRequest();
  // Bumped after a status change / mark-paid: the fetch effect owns EVERY request, so the refetch
  // reads the CURRENT filters/page, not the closure captured when the action started (issue 2443).
  const [refreshKey, setRefreshKey] = useState(0);
  const fetchOrders = useCallback(async () => {
    if (!storeId) return;
    const isLatest = beginRequest();
    setIsLoading(true);
    setError(null);
    try {
      const { params: qs, headers } = moveSearchToHeader(filterParams());
      qs.set('page', pagination.page.toString());
      qs.set('limit', pagination.limit.toString());

      // The API (OrderService.list) returns pagination under `meta`, not
      // `pagination`. Reading the wrong key left `total`/`totalPages` at 0 —
      // the footer showed "0 of 0" and Next stayed disabled, so a merchant
      // with real (e.g. pending/unpaid) orders saw a list that looked empty
      // and couldn't page to older orders. Accept both keys defensively.
      const { data, error: apiError } = await apiGet<{
        orders: Order[];
        meta?: Pagination;
        pagination?: Pagination;
      }>(`/api/v1/stores/${storeId}/orders?${qs}`, headers);
      if (!isLatest()) return;

      if (apiError) {
        setError(apiError.message || t('errors.fetchFailed'));
      } else {
        setOrders(data?.orders || []);
        const pageMeta = data?.meta ?? data?.pagination;
        if (pageMeta) {
          setPagination(prev => ({ ...prev, ...pageMeta }));
        }
      }
    } catch {
      if (isLatest()) setError(t('errors.connection'));
    } finally {
      if (isLatest()) setIsLoading(false);
    }
  }, [storeId, pagination.page, pagination.limit, filterParams, t, beginRequest]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders, refreshKey]);

  /**
   * Trigger the server-side XLSX export. Uses apiFetch (which forwards the
   * Authorization Bearer header from localStorage) to download the binary
   * stream, then blobs → object URL → anchor click to save the file.
   * Mirrors the customers page export pattern exactly.
   */
  const handleExport = useCallback(async () => {
    if (!storeId || isExporting) return;
    setIsExporting(true);
    try {
      // Same filters as the list on screen; tzOffset lets the file name the
      // range in the viewer's days.
      const { params: qs, headers } = moveSearchToHeader(filterParams());
      qs.set('tzOffset', String(-new Date().getTimezoneOffset()));
      const res = await apiFetch(`/api/v1/stores/${storeId}/orders/export.xlsx?${qs}`, { headers });
      if (!res.ok) {
        showError(t('export.failed'));
        return;
      }
      const blob = await res.blob();
      const filename = (() => {
        const cd = res.headers.get('content-disposition') ?? '';
        const match = cd.match(/filename="?([^"]+)"?/i);
        return (
          match?.[1] ?? exportFilename('orders', resolveDateRange(period, customRange), 'xlsx')
        );
      })();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      showError(t('export.failed'));
    } finally {
      setIsExporting(false);
    }
  }, [storeId, isExporting, filterParams, period, customRange, t, showError]);

  // Choosing "Refunded" in the status dropdown only RECORDS a refund: it
  // reverses stock/coupon/loyalty and sends the customer a "Refund issued"
  // notification, but moves NO money — that is "Refund via provider" on the
  // order page. Confirm first so a paid order is never marked refunded (and
  // the customer told so) by a stray pick (#762).
  const handleStatusChange = async (order: Order, newStatus: string) => {
    if (newStatus === 'refunded') {
      if (!canRefund) return;
      setConfirmState({ open: true, type: 'manualRefund', orderId: order.id, order });
      return;
    }
    await executeStatusChange(order, newStatus);
  };

  const executeStatusChange = async (order: Order, newStatus: string) => {
    setUpdatingId(order.id);
    try {
      const { error: apiError } = await apiPut(
        `/api/v1/stores/${storeId}/orders/${order.id}/status`,
        { status: newStatus }
      );
      if (!apiError) {
        // Optimistically update the row, then re-fetch to sync
        setOrders(prev => prev.map(o => (o.id === order.id ? { ...o, status: newStatus } : o)));
        toastSuccess(
          t('toast.statusUpdatedTitle'),
          t('toast.statusUpdatedDescription', { status: t(`status.${newStatus}`) })
        );
        setRefreshKey(k => k + 1);
      } else {
        showError(t('toast.errorTitle'), apiError.message || t('errors.statusUpdate'));
      }
    } catch {
      showError(t('toast.errorTitle'), t('errors.connection'));
    } finally {
      setUpdatingId(null);
    }
  };

  // Records a refund the merchant has already paid out. Resolves to null on success, or the API's
  // message (403 for staff, 409 REFUND_NOT_RECORDED) for the dialog to show.
  const executeManualRefund = async (order: Order, input: ManualRefundInput) => {
    setUpdatingId(order.id);
    try {
      const { error: apiError } = await apiPut(
        `/api/v1/stores/${storeId}/orders/${order.id}/status`,
        manualRefundBody(input)
      );
      if (apiError) return apiError.message || t('errors.statusUpdate');
      setOrders(prev => prev.map(o => (o.id === order.id ? { ...o, status: 'refunded' } : o)));
      toastSuccess(
        t('toast.statusUpdatedTitle'),
        t('toast.statusUpdatedDescription', { status: t('status.refunded') })
      );
      setRefreshKey(k => k + 1);
      return null;
    } catch {
      return t('errors.connection');
    } finally {
      setUpdatingId(null);
    }
  };

  const openInvoice = async (orderId: string) => {
    // Direct window.open() to the API host bypasses our auth helpers,
    // so on iPhone PWA (where webkit purges the third-party cookie)
    // the merchant landed on a raw 401 json blob. Fetch the html via
    // apiFetch — which forwards the Authorization: Bearer header from
    // localStorage — then surface it as a blob: url in a new tab.
    try {
      const res = await apiFetch(`/api/v1/stores/${storeId}/orders/${orderId}/invoice`);
      if (!res.ok) {
        showError(t('errors.invoiceLoad'), t('errors.invoiceLoadHttp', { status: res.status }));
        return;
      }
      const html = await res.text();
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      // Revoke after a delay so the new tab has time to consume the URL.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      showError(t('errors.invoiceLoad'), t('errors.connection'));
    }
  };

  // Open the confirm modal for a single order. Actual API work runs in
  // executeMarkPaid after the user confirms.
  const handleMarkPaid = (orderId: string) => {
    setConfirmState({ open: true, type: 'markPaid', orderId });
  };

  const executeMarkPaid = async (orderId: string) => {
    setUpdatingId(orderId);
    try {
      const { error: apiError } = await apiPost(
        `/api/v1/stores/${storeId}/orders/${orderId}/mark-paid`,
        {}
      );
      if (!apiError) {
        toastSuccess(t('toast.markedPaidTitle'), t('toast.markedPaidDescription'));
        // Optimistically reflect the new state so the "Mark Paid" button
        // hides immediately. The authoritative refetch below corrects any
        // drift; without this, the button can linger until the round-trip
        // completes and look like the action didn't take effect.
        setOrders(prev =>
          prev.map(o =>
            o.id === orderId
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
        setRefreshKey(k => k + 1);
      } else {
        showError(t('toast.errorTitle'), apiError.message || t('errors.markPaid'));
      }
    } catch {
      showError(t('toast.errorTitle'), t('errors.connection'));
    } finally {
      setUpdatingId(null);
    }
  };

  const handleBulkMarkPaid = () => {
    const ids = Array.from(selectedOrders);
    if (ids.length === 0) return;
    setConfirmState({ open: true, type: 'bulkMarkPaid', ids });
  };

  const executeBulkMarkPaid = async (ids: string[]) => {
    setIsBulkProcessing(true);
    try {
      const { data, error: apiError } = await apiPost<{ updated: number; skipped: number }>(
        `/api/v1/stores/${storeId}/orders/bulk-mark-paid`,
        { orderIds: ids }
      );
      if (!apiError && data) {
        toastSuccess(
          t('toast.bulkUpdateTitle'),
          t('toast.bulkUpdateDescription', { count: data.updated })
        );
        // Optimistic update for every selected order (same shape as single
        // mark-paid above) so the bulk-bar mark-paid buttons hide instantly.
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
        setRefreshKey(k => k + 1);
      } else {
        showError(t('toast.errorTitle'), apiError?.message || t('errors.bulkMarkPaid'));
      }
    } catch {
      showError(t('toast.errorTitle'), t('errors.connection'));
    } finally {
      setIsBulkProcessing(false);
    }
  };

  const handleConfirm = async () => {
    if (confirmState.type === 'markPaid' && confirmState.orderId) {
      const id = confirmState.orderId;
      setConfirmState(prev => ({ ...prev, open: false }));
      await executeMarkPaid(id);
    } else if (confirmState.type === 'bulkMarkPaid' && confirmState.ids) {
      const ids = confirmState.ids;
      setConfirmState(prev => ({ ...prev, open: false }));
      await executeBulkMarkPaid(ids);
    }
  };

  const closeConfirm = () => setConfirmState(prev => ({ ...prev, open: false }));

  const confirmTitle =
    confirmState.type === 'markPaid' ? tConfirm('markPaidTitle') : tConfirm('bulkMarkPaidTitle');

  const confirmDescription =
    confirmState.type === 'markPaid'
      ? tConfirm('markPaidDescription')
      : tConfirm('bulkMarkPaidDescription', { count: confirmState.ids?.length ?? 0 });

  const isConfirmLoading =
    (confirmState.type === 'markPaid' && updatingId === confirmState.orderId) ||
    (confirmState.type === 'bulkMarkPaid' && isBulkProcessing);

  const handleToggleSelected = (orderId: string, checked: boolean) => {
    setSelectedOrders(prev => {
      const next = new Set(prev);
      if (checked) {
        next.add(orderId);
      } else {
        next.delete(orderId);
      }
      return next;
    });
  };

  // The server already applied every filter (search included).
  const filteredOrders = orders;

  const hasActiveFilters = Boolean(search) || statusFilter !== 'all';

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <div className="flex items-center gap-2">
          {/* Rule 2: one primary (phone order), export lives in the "..." menu (owners only: the sheet carries
              every customer's PII, SEC-14). */}
          {canExport && (
            <RowActions
              menuLabel={t('moreMenu')}
              items={[
                {
                  label: isExporting ? t('export.exporting') : t('export.button'),
                  onSelect: handleExport,
                  disabled: isLoading || isExporting,
                },
              ]}
            />
          )}
          <Link href={`/stores/${storeId}/orders/new`} className={buttonVariants()}>
            {t('newOrder')}
          </Link>
        </div>
      }
    >
      <PlanLimitNotice storeId={storeId} keys={['maxOrdersPerMonth']} />

      <DateRangePicker
        period={period}
        custom={customRange}
        onChange={(p, c) => {
          setPeriod(p);
          if (c) setCustomRange(c);
          setPagination(prev => ({ ...prev, page: 1 }));
        }}
      />

      <OrdersFilters
        statusFilter={statusFilter}
        onStatusFilterChange={status => {
          setStatusFilter(status);
          setPagination(prev => ({ ...prev, page: 1 }));
        }}
        search={search}
        onSearchChange={setSearch}
      />

      {error && (
        <div className="mb-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive-ink">
          {error}
          <button type="button" className="ms-4 font-medium underline" onClick={fetchOrders}>
            {t('errors.retry')}
          </button>
        </div>
      )}

      <OrdersBulkBar
        storeId={storeId}
        selectedIds={Array.from(selectedOrders)}
        selectedCount={selectedOrders.size}
        isProcessing={isBulkProcessing}
        onMarkPaid={handleBulkMarkPaid}
        onClearSelection={() => setSelectedOrders(new Set())}
      />

      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <OrdersTable
          orders={filteredOrders}
          isLoading={isLoading}
          hasActiveFilters={hasActiveFilters}
          updatingId={updatingId}
          selectedOrders={selectedOrders}
          canRefund={canRefund}
          onStatusChange={handleStatusChange}
          onMarkPaid={handleMarkPaid}
          onOpenInvoice={openInvoice}
          onToggleSelected={handleToggleSelected}
        />

        <OrdersPagination
          pagination={pagination}
          onPageChange={updater => setPagination(prev => ({ ...prev, page: updater(prev.page) }))}
          onLimitChange={limit => {
            if (limitStorageKey) window.localStorage.setItem(limitStorageKey, String(limit));
            setPagination(prev => ({ ...prev, limit, page: 1 }));
          }}
        />
      </div>

      <ManualRefundModal
        open={confirmState.open && confirmState.type === 'manualRefund'}
        orderStatus={confirmState.order?.status}
        onConfirm={input =>
          confirmState.order
            ? executeManualRefund(confirmState.order, input)
            : Promise.resolve(tConfirm('refundFailed'))
        }
        onClose={closeConfirm}
      />

      <ConfirmActionModal
        open={confirmState.open && confirmState.type !== 'manualRefund'}
        title={confirmTitle}
        description={confirmDescription}
        confirmLabel={
          confirmState.type === 'markPaid'
            ? tConfirm('markPaidLabel')
            : tConfirm('bulkMarkPaidLabel')
        }
        cancelLabel={tConfirm('cancel')}
        onConfirm={handleConfirm}
        onClose={closeConfirm}
        isLoading={isConfirmLoading}
      />
    </AdminLayout>
  );
}
