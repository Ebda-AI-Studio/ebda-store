'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button, Modal } from '@force/ui';
import { AdminLayout } from '../../components/AdminLayout';
import { ErrorState } from '../../components/ErrorState';
import { useAuth } from '../../lib/auth';

interface OrderItem {
  id: string;
  name: string;
  quantity: number;
  price: number;
}

interface Order {
  id: string;
  orderNumber?: string;
  customer: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
  store?: {
    id: string;
    name: string;
  };
  items: OrderItem[];
  total: number;
  status: string;
  paymentStatus: string;
  createdAt: string;
  shippingAddress?: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

function formatPrice(fils: number) {
  return new Intl.NumberFormat('en-KW', {
    style: 'currency',
    currency: 'KWD',
    minimumFractionDigits: 3,
  }).format(fils / 1000);
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatDateTime(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const statusConfig = {
  pending: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500', icon: '⏳' },
  processing: { bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-500', icon: '⚙️' },
  shipped: { bg: 'bg-violet-50', text: 'text-violet-700', dot: 'bg-violet-500', icon: '📦' },
  delivered: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500', icon: '✓' },
  cancelled: { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500', icon: '✗' },
} as const;

const paymentConfig = {
  pending: { bg: 'bg-amber-50', text: 'text-amber-700' },
  paid: { bg: 'bg-emerald-50', text: 'text-emerald-700' },
  refunded: { bg: 'bg-gray-100', text: 'text-gray-600' },
  failed: { bg: 'bg-red-50', text: 'text-red-700' },
} as const;

// Status options for future dropdown filter
const _statusOptions = [
  { value: 'pending', label: 'Pending' },
  { value: 'processing', label: 'Processing' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancelled', label: 'Cancelled' },
];
void _statusOptions; // Suppress unused warning

export default function OrdersPage() {
  const { token } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);

  const fetchOrders = useCallback(async () => {
    if (!token) return;

    try {
      setError(null);
      setIsLoading(true);
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        limit: pagination.limit.toString(),
      });
      if (statusFilter !== 'all') params.append('status', statusFilter);

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/admin/orders?${params}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (response.ok) {
        const data = await response.json();
        setOrders(data.data.orders || []);
        if (data.data.pagination) {
          setPagination(prev => ({ ...prev, ...data.data.pagination }));
        }
      } else {
        const errorData = await response.json().catch(() => ({}));
        setError(errorData.error?.message || 'Failed to fetch orders');
      }
    } catch (error) {
      console.error('Failed to fetch orders:', error);
      setError('Unable to connect to the server. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  }, [token, pagination.page, pagination.limit, statusFilter]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  const filteredOrders = orders.filter(order => {
    if (!search) return true;
    const searchLower = search.toLowerCase();
    return (
      order.id.toLowerCase().includes(searchLower) ||
      order.orderNumber?.toLowerCase().includes(searchLower) ||
      order.customer?.firstName?.toLowerCase().includes(searchLower) ||
      order.customer?.lastName?.toLowerCase().includes(searchLower) ||
      order.customer?.email?.toLowerCase().includes(searchLower)
    );
  });

  const viewOrderDetails = (order: Order) => {
    setSelectedOrder(order);
    setIsDetailModalOpen(true);
  };

  // Calculate stats from orders
  const stats = {
    total: pagination.total || orders.length,
    pending: orders.filter(o => o.status === 'pending').length,
    processing: orders.filter(o => o.status === 'processing').length,
    shipped: orders.filter(o => o.status === 'shipped').length,
    delivered: orders.filter(o => o.status === 'delivered').length,
  };

  const getStatusStyle = (status: string) => {
    return statusConfig[status as keyof typeof statusConfig] || statusConfig.pending;
  };

  const getPaymentStyle = (status: string) => {
    return paymentConfig[status as keyof typeof paymentConfig] || paymentConfig.pending;
  };

  return (
    <AdminLayout title="Orders" subtitle={`${stats.total} orders across all stores`}>
      {/* Stats Cards */}
      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-5 stagger-animation">
        {[
          {
            label: 'Total Orders',
            value: stats.total,
            color: 'from-gray-600 to-gray-700',
            bg: 'bg-gray-50',
          },
          {
            label: 'Pending',
            value: stats.pending,
            color: 'from-amber-500 to-amber-600',
            bg: 'bg-amber-50',
          },
          {
            label: 'Processing',
            value: stats.processing,
            color: 'from-blue-500 to-blue-600',
            bg: 'bg-blue-50',
          },
          {
            label: 'Shipped',
            value: stats.shipped,
            color: 'from-violet-500 to-violet-600',
            bg: 'bg-violet-50',
          },
          {
            label: 'Delivered',
            value: stats.delivered,
            color: 'from-emerald-500 to-emerald-600',
            bg: 'bg-emerald-50',
          },
        ].map((stat, index) => (
          <div
            key={stat.label}
            className="force-card group overflow-hidden"
            style={{ animationDelay: `${index * 0.05}s` }}
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {stat.label}
                </p>
                <p className="mt-2 text-3xl font-bold text-foreground">{stat.value}</p>
              </div>
              <div
                className={`flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br ${stat.color} text-white shadow-lg transition-transform group-hover:scale-110`}
              >
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                  />
                </svg>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-1 rounded-xl bg-muted/50 p-1 overflow-x-auto">
          {['all', 'pending', 'processing', 'shipped', 'delivered', 'cancelled'].map(status => (
            <button
              key={status}
              onClick={() => {
                setStatusFilter(status);
                setPagination(prev => ({ ...prev, page: 1 }));
              }}
              className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-all ${
                statusFilter === status
                  ? 'bg-white text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {status === 'all' ? 'All Orders' : status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-72">
          <svg
            className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
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
            className="force-input pl-11"
          />
        </div>
      </div>

      {/* Error State */}
      {error && !isLoading && (
        <ErrorState title="Failed to load orders" message={error} onRetry={fetchOrders} />
      )}

      {/* Orders Table */}
      {!error && isLoading ? (
        <div className="force-card p-0 overflow-hidden">
          <div className="space-y-4 p-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 animate-pulse">
                <div className="h-10 w-10 rounded-xl bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-32 rounded bg-muted" />
                  <div className="h-3 w-48 rounded bg-muted" />
                </div>
                <div className="h-6 w-20 rounded-full bg-muted" />
              </div>
            ))}
          </div>
        </div>
      ) : !error && filteredOrders.length > 0 ? (
        <div className="force-card p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Order
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Customer
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider hidden lg:table-cell">
                    Store
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Total
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider hidden md:table-cell">
                    Payment
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider hidden sm:table-cell">
                    Date
                  </th>
                  <th className="px-6 py-4 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {filteredOrders.map(order => {
                  const statusStyle = getStatusStyle(order.status);
                  const paymentStyle = getPaymentStyle(order.paymentStatus);
                  return (
                    <tr key={order.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div
                            className={`flex h-10 w-10 items-center justify-center rounded-xl ${statusStyle.bg}`}
                          >
                            <span className="text-lg">{statusStyle.icon}</span>
                          </div>
                          <div>
                            <p className="font-semibold text-primary">
                              {order.orderNumber || `#${order.id.slice(0, 8).toUpperCase()}`}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {order.items?.length || 0} items
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div>
                          <p className="font-medium text-foreground">
                            {order.customer?.firstName} {order.customer?.lastName}
                          </p>
                          <p className="text-sm text-muted-foreground">{order.customer?.email}</p>
                        </div>
                      </td>
                      <td className="px-6 py-4 hidden lg:table-cell">
                        <span className="text-sm text-muted-foreground">
                          {order.store?.name || 'N/A'}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-lg font-bold text-foreground">
                          {formatPrice(order.total)}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${statusStyle.bg} ${statusStyle.text}`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full ${statusStyle.dot}`} />
                          {order.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 hidden md:table-cell">
                        <span
                          className={`inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-medium ${paymentStyle.bg} ${paymentStyle.text}`}
                        >
                          {order.paymentStatus}
                        </span>
                      </td>
                      <td className="px-6 py-4 hidden sm:table-cell">
                        <span className="text-sm text-muted-foreground">
                          {formatDate(order.createdAt)}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="rounded-xl"
                            onClick={() => viewOrderDetails(order)}
                          >
                            <svg
                              className="h-4 w-4"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                              />
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                              />
                            </svg>
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {pagination.totalPages > 1 && (
            <div className="flex items-center justify-between border-t px-6 py-4">
              <p className="text-sm text-muted-foreground">
                Showing{' '}
                <span className="font-medium text-foreground">
                  {(pagination.page - 1) * pagination.limit + 1}
                </span>{' '}
                to{' '}
                <span className="font-medium text-foreground">
                  {Math.min(pagination.page * pagination.limit, pagination.total)}
                </span>{' '}
                of <span className="font-medium text-foreground">{pagination.total}</span> orders
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-xl"
                  disabled={pagination.page === 1}
                  onClick={() => setPagination(prev => ({ ...prev, page: prev.page - 1 }))}
                >
                  ← Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-xl"
                  disabled={pagination.page === pagination.totalPages}
                  onClick={() => setPagination(prev => ({ ...prev, page: prev.page + 1 }))}
                >
                  Next →
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : !error ? (
        /* Empty State */
        <div className="force-card py-16">
          <div className="flex flex-col items-center text-center">
            <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-primary/20 to-primary/5">
              <svg
                className="h-10 w-10 text-primary"
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
            <h3 className="text-xl font-semibold text-foreground mb-2">No orders found</h3>
            <p className="text-muted-foreground mb-6 max-w-sm">
              {search || statusFilter !== 'all'
                ? 'Try adjusting your search or filter criteria'
                : 'Orders will appear here when customers make purchases'}
            </p>
          </div>
        </div>
      ) : null}

      {/* Order Detail Modal */}
      <Modal
        isOpen={isDetailModalOpen}
        onClose={() => setIsDetailModalOpen(false)}
        title={`Order ${selectedOrder?.orderNumber || selectedOrder?.id?.slice(0, 8).toUpperCase()}`}
      >
        {selectedOrder && (
          <div className="space-y-6">
            {/* Status & Payment Badges */}
            <div className="flex items-center gap-3">
              {(() => {
                const statusStyle = getStatusStyle(selectedOrder.status);
                return (
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ${statusStyle.bg} ${statusStyle.text}`}
                  >
                    <span className={`h-2 w-2 rounded-full ${statusStyle.dot}`} />
                    {selectedOrder.status}
                  </span>
                );
              })()}
              {(() => {
                const paymentStyle = getPaymentStyle(selectedOrder.paymentStatus);
                return (
                  <span
                    className={`inline-flex items-center rounded-lg px-3 py-1 text-sm font-medium ${paymentStyle.bg} ${paymentStyle.text}`}
                  >
                    {selectedOrder.paymentStatus}
                  </span>
                );
              })()}
            </div>

            {/* Customer Info */}
            <div className="rounded-xl bg-muted/30 p-4">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Customer
              </h4>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-sm font-bold text-primary">
                  {selectedOrder.customer?.firstName?.[0]}
                  {selectedOrder.customer?.lastName?.[0]}
                </div>
                <div>
                  <p className="font-medium text-foreground">
                    {selectedOrder.customer?.firstName} {selectedOrder.customer?.lastName}
                  </p>
                  <p className="text-sm text-muted-foreground">{selectedOrder.customer?.email}</p>
                </div>
              </div>
            </div>

            {/* Store Info */}
            {selectedOrder.store && (
              <div className="rounded-xl bg-muted/30 p-4">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  Store
                </h4>
                <p className="font-medium text-foreground">{selectedOrder.store.name}</p>
              </div>
            )}

            {/* Shipping Address */}
            {selectedOrder.shippingAddress && (
              <div className="rounded-xl bg-muted/30 p-4">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  Shipping Address
                </h4>
                <p className="text-sm text-foreground">{selectedOrder.shippingAddress}</p>
              </div>
            )}

            {/* Items */}
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Order Items
              </h4>
              <div className="space-y-3">
                {selectedOrder.items?.map((item, index) => (
                  <div
                    key={index}
                    className="flex justify-between items-center py-2 border-b border-border/50 last:border-0"
                  >
                    <div>
                      <span className="font-medium text-foreground">{item.name}</span>
                      <span className="text-muted-foreground ml-2">× {item.quantity}</span>
                    </div>
                    <span className="font-semibold text-foreground">
                      {formatPrice(item.price * item.quantity)}
                    </span>
                  </div>
                ))}
                <div className="flex justify-between items-center pt-3 border-t-2 border-border">
                  <span className="text-lg font-bold text-foreground">Total</span>
                  <span className="text-xl font-bold text-primary">
                    {formatPrice(selectedOrder.total)}
                  </span>
                </div>
              </div>
            </div>

            {/* Order Date */}
            <div className="text-xs text-muted-foreground">
              Ordered on {formatDateTime(selectedOrder.createdAt)}
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button
                variant="outline"
                className="rounded-xl"
                onClick={() => setIsDetailModalOpen(false)}
              >
                Close
              </Button>
              <Button className="rounded-xl shadow-lg shadow-primary/25">
                <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"
                  />
                </svg>
                Print Invoice
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </AdminLayout>
  );
}
