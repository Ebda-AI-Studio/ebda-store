'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut, getApiUrl } from '../../../../lib/api';

interface OrderCustomer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

interface Order {
  id: string;
  orderNumber?: string;
  customer: OrderCustomer;
  total: number;
  status: string;
  paymentStatus: string;
  createdAt: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const API_URL = getApiUrl();

// Valid status transitions — matches the platform-wide orders page
const validTransitions: Record<string, string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: ['refunded'],
};

const statusStyles: Record<string, { bg: string; text: string; dot: string }> = {
  pending: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
  confirmed: { bg: 'bg-cyan-50', text: 'text-cyan-700', dot: 'bg-cyan-500' },
  processing: { bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-500' },
  shipped: { bg: 'bg-violet-50', text: 'text-violet-700', dot: 'bg-violet-500' },
  delivered: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  cancelled: { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500' },
  refunded: { bg: 'bg-muted', text: 'text-muted-foreground', dot: 'bg-muted-foreground' },
};

function getStatusStyle(status: string) {
  return statusStyles[status] ?? statusStyles.pending;
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function StoreOrdersPage() {
  const params = useParams();
  const storeId = params?.id as string;

  const [orders, setOrders] = useState<Order[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [updatingId, setUpdatingId] = useState<string | null>(null);
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
        setError(apiError.message || 'Failed to fetch orders');
      } else {
        setOrders(data?.orders || []);
        if (data?.pagination) {
          setPagination(prev => ({ ...prev, ...data.pagination }));
        }
      }
    } catch {
      setError('Unable to connect to the server. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  }, [storeId, pagination.page, pagination.limit, statusFilter]);

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
        toastSuccess('Status Updated', `Order status changed to ${newStatus}.`);
        fetchOrders();
      } else {
        showError('Error', apiError.message || 'Failed to update status');
      }
    } catch {
      showError('Error', 'Unable to connect to the server');
    } finally {
      setUpdatingId(null);
    }
  };

  const openInvoice = (orderId: string) => {
    window.open(`${API_URL}/api/v1/stores/${storeId}/orders/${orderId}/invoice`, '_blank');
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

  return (
    <AdminLayout
      title="Store Orders"
      subtitle="View and manage orders for this store"
      actions={
        <Link href={`/stores/${storeId}`}>
          <button className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted font-medium">
            Back to Store
          </button>
        </Link>
      }
    >
      {/* Status Filter Tabs */}
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-1 rounded-xl bg-muted p-1 overflow-x-auto">
          {['all', 'pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'].map(
            status => (
              <button
                key={status}
                onClick={() => {
                  setStatusFilter(status);
                  setPagination(prev => ({ ...prev, page: 1 }));
                }}
                className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-all ${
                  statusFilter === status
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {status === 'all' ? 'All Orders' : status.charAt(0).toUpperCase() + status.slice(1)}
              </button>
            )
          )}
        </div>

        <div className="relative w-full sm:w-72">
          <svg
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            placeholder="Search orders..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full rounded-lg border py-2 pl-10 pr-4 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
          <button className="ml-4 font-medium underline" onClick={fetchOrders}>
            Retry
          </button>
        </div>
      )}

      {/* Orders Table */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted border-b">
                <tr>
                  {['Order', 'Customer', 'Total', 'Status', 'Date', 'Actions'].map(h => (
                    <th
                      key={h}
                      className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    <td className="px-6 py-4">
                      <div className="h-4 w-24 force-skeleton" />
                    </td>
                    <td className="px-6 py-4">
                      <div className="space-y-1.5">
                        <div className="h-4 w-32 force-skeleton" />
                        <div className="h-3 w-40 force-skeleton" />
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="h-4 w-20 force-skeleton" />
                    </td>
                    <td className="px-6 py-4">
                      <div className="h-6 w-24 rounded-full force-skeleton" />
                    </td>
                    <td className="px-6 py-4 hidden md:table-cell">
                      <div className="h-4 w-24 force-skeleton" />
                    </td>
                    <td className="px-6 py-4">
                      <div className="h-7 w-20 rounded-lg force-skeleton ml-auto" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : filteredOrders.length === 0 ? (
          <div className="force-empty-state">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
              <svg
                className="h-8 w-8 text-muted-foreground"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                />
              </svg>
            </div>
            <p className="font-semibold text-foreground">
              {search || statusFilter !== 'all' ? 'No matching orders' : 'No orders yet'}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {search || statusFilter !== 'all'
                ? 'Try adjusting your search or filters'
                : 'Orders will appear here when customers make purchases'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted border-b">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Order
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Customer
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Total
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider hidden md:table-cell">
                    Date
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredOrders.map(order => {
                  const style = getStatusStyle(order.status);
                  const transitions = validTransitions[order.status] ?? [];
                  const isUpdating = updatingId === order.id;
                  return (
                    <tr
                      key={order.id}
                      className="hover:bg-muted/50 transition-colors duration-150 cursor-pointer"
                    >
                      <td className="px-6 py-4">
                        <p className="font-semibold text-primary">
                          {order.orderNumber || `#${order.id.slice(0, 8).toUpperCase()}`}
                        </p>
                      </td>
                      <td className="px-6 py-4">
                        <p className="font-medium text-foreground">
                          {order.customer?.firstName} {order.customer?.lastName}
                        </p>
                        <p className="text-sm text-muted-foreground">{order.customer?.email}</p>
                      </td>
                      <td className="px-6 py-4">
                        <span className="font-bold text-foreground">
                          {(order.total / 1000).toFixed(3)} KWD
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        {transitions.length > 0 ? (
                          <div className="flex items-center gap-2">
                            <span
                              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${style.bg} ${style.text}`}
                            >
                              <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
                              {order.status}
                            </span>
                            <select
                              aria-label="Update order status"
                              className="rounded-lg border border-border px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                              disabled={isUpdating}
                              defaultValue=""
                              onChange={e => {
                                if (e.target.value) {
                                  handleStatusChange(order, e.target.value);
                                  e.target.value = '';
                                }
                              }}
                            >
                              <option value="" disabled>
                                Update...
                              </option>
                              {transitions.map(s => (
                                <option key={s} value={s}>
                                  {s.charAt(0).toUpperCase() + s.slice(1)}
                                </option>
                              ))}
                            </select>
                            {isUpdating && (
                              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                            )}
                          </div>
                        ) : (
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${style.bg} ${style.text}`}
                          >
                            <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
                            {order.status}
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 hidden md:table-cell text-sm text-muted-foreground">
                        {formatDate(order.createdAt)}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <button
                          onClick={() => openInvoice(order.id)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-foreground border border-border rounded-lg hover:bg-muted transition-colors"
                          title="View Invoice"
                        >
                          <svg
                            className="h-3.5 w-3.5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"
                            />
                          </svg>
                          Invoice
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-6 py-3">
            <p className="text-sm text-muted-foreground">
              Showing {(pagination.page - 1) * pagination.limit + 1} to{' '}
              {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}{' '}
              orders
            </p>
            <div className="flex gap-2">
              <button
                className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={pagination.page === 1}
                onClick={() => setPagination(prev => ({ ...prev, page: prev.page - 1 }))}
              >
                Previous
              </button>
              <button
                className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={pagination.page === pagination.totalPages}
                onClick={() => setPagination(prev => ({ ...prev, page: prev.page + 1 }))}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
