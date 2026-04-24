'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button, useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut, apiPost, getApiUrl } from '../../../../lib/api';
import { useT } from '@/i18n/useT';
import { OrdersFilters } from './_components/OrdersFilters';
import { OrdersBulkBar } from './_components/OrdersBulkBar';
import { OrdersTable } from './_components/OrdersTable';
import { OrdersPagination } from './_components/OrdersPagination';
import type { Order, Pagination, StatusFilter } from './_components/types';
import { ConfirmActionModal } from '../../../../components/ConfirmActionModal';

type ConfirmType = 'markPaid' | 'bulkMarkPaid';

interface ConfirmState {
  open: boolean;
  type: ConfirmType;
  orderId?: string;
  ids?: string[];
}

const API_URL = getApiUrl();

export default function StoreOrdersPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('orders.list');
  const tConfirm = useT('orders.list.confirm');

  const [orders, setOrders] = useState<Order[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 20,
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

  const fetchOrders = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        page: pagination.page.toString(),
        limit: pagination.limit.toString(),
      });
      if (statusFilter !== 'all') qs.set('status', statusFilter);

      const { data, error: apiError } = await apiGet<{
        orders: Order[];
        pagination: Pagination;
      }>(`/api/v1/stores/${storeId}/orders?${qs}`);

      if (apiError) {
        setError(apiError.message || t('errors.fetchFailed'));
      } else {
        setOrders(data?.orders || []);
        if (data?.pagination) {
          setPagination(prev => ({ ...prev, ...data.pagination }));
        }
      }
    } catch {
      setError(t('errors.connection'));
    } finally {
      setIsLoading(false);
    }
  }, [storeId, pagination.page, pagination.limit, statusFilter, t]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  const handleStatusChange = async (order: Order, newStatus: string) => {
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
        fetchOrders();
      } else {
        showError(t('toast.errorTitle'), apiError.message || t('errors.statusUpdate'));
      }
    } catch {
      showError(t('toast.errorTitle'), t('errors.connection'));
    } finally {
      setUpdatingId(null);
    }
  };

  const openInvoice = (orderId: string) => {
    window.open(`${API_URL}/api/v1/stores/${storeId}/orders/${orderId}/invoice`, '_blank');
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
        fetchOrders();
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
        setSelectedOrders(new Set());
        fetchOrders();
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

  // Client-side search on already-fetched page
  const filteredOrders = orders.filter(order => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      (order.orderNumber ?? '').toLowerCase().includes(s) ||
      order.id.toLowerCase().includes(s) ||
      order.customer?.firstName?.toLowerCase().includes(s) ||
      order.customer?.lastName?.toLowerCase().includes(s) ||
      order.customer?.email?.toLowerCase().includes(s)
    );
  });

  const hasActiveFilters = Boolean(search) || statusFilter !== 'all';

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <Link href={`/stores/${storeId}`}>
          <Button type="button" variant="outline">
            {t('backToStore')}
          </Button>
        </Link>
      }
    >
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
        <div className="mb-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
          <button type="button" className="ms-4 font-medium underline" onClick={fetchOrders}>
            {t('errors.retry')}
          </button>
        </div>
      )}

      <OrdersBulkBar
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
          onStatusChange={handleStatusChange}
          onMarkPaid={handleMarkPaid}
          onOpenInvoice={openInvoice}
          onToggleSelected={handleToggleSelected}
        />

        <OrdersPagination
          pagination={pagination}
          onPageChange={updater => setPagination(prev => ({ ...prev, page: updater(prev.page) }))}
        />
      </div>

      <ConfirmActionModal
        open={confirmState.open}
        title={confirmTitle}
        description={confirmDescription}
        confirmLabel={tConfirm('confirm')}
        cancelLabel={tConfirm('cancel')}
        onConfirm={handleConfirm}
        onClose={closeConfirm}
        isLoading={isConfirmLoading}
      />
    </AdminLayout>
  );
}
