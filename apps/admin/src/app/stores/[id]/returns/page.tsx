'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Button, Badge } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { getApiUrl } from '../../../../lib/api';

interface ReturnItem {
  id: string;
  productName: string;
  quantity: number;
  reason?: string;
  condition?: string;
  product?: {
    name: string;
    images?: { url: string }[];
  };
}

interface Return {
  id: string;
  returnNumber: string;
  type: 'return' | 'exchange' | 'refund';
  status: string;
  reason: string;
  reasonDetail?: string;
  refundAmount: number;
  refundMethod?: string;
  trackingNumber?: string;
  customerNotes?: string;
  adminNotes?: string;
  createdAt: string;
  approvedAt?: string;
  receivedAt?: string;
  refundedAt?: string;
  order: {
    orderNumber: string;
    total: number;
  };
  customer: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  items: ReturnItem[];
}

interface Stats {
  total: number;
  pending: number;
  approved: number;
  completed: number;
}

function formatDate(date: string) {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-KW', {
    style: 'currency',
    currency: 'KWD',
    minimumFractionDigits: 3,
  }).format(amount / 1000);
}

const statusColors: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-blue-100 text-blue-800',
  rejected: 'bg-red-100 text-red-800',
  shipped: 'bg-purple-100 text-purple-800',
  received: 'bg-indigo-100 text-indigo-800',
  inspecting: 'bg-cyan-100 text-cyan-800',
  completed: 'bg-green-100 text-green-800',
  cancelled: 'bg-gray-100 text-gray-800',
};

const typeLabels: Record<string, string> = {
  return: 'Return',
  exchange: 'Exchange',
  refund: 'Refund',
};

export default function ReturnsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const [returns, setReturns] = useState<Return[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'completed'>('all');
  const [meta, setMeta] = useState({ page: 1, limit: 20, total: 0, totalPages: 1 });
  const [selectedReturn, setSelectedReturn] = useState<Return | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const fetchReturns = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      const token = localStorage.getItem('authToken');
      const statusFilter = filter === 'all' ? '' : `&status=${filter}`;
      const response = await fetch(
        `${getApiUrl()}/api/v1/stores/${storeId}/returns/admin/list?page=${meta.page}&limit=${meta.limit}${statusFilter}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (response.ok) {
        const data = await response.json();
        setReturns(data.data.returns);
        setMeta(data.data.meta);
      }
    } catch (error) {
      console.error('Failed to fetch returns:', error);
    } finally {
      setIsLoading(false);
    }
  }, [storeId, filter, meta.page, meta.limit]);

  const fetchStats = useCallback(async () => {
    if (!storeId) return;
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`${getApiUrl()}/api/v1/stores/${storeId}/returns/admin/stats`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const data = await response.json();
        setStats(data.data.stats);
      }
    } catch (error) {
      console.error('Failed to fetch stats:', error);
    }
  }, [storeId]);

  useEffect(() => {
    fetchReturns();
    fetchStats();
  }, [fetchReturns, fetchStats]);

  async function handleApprove(returnId: string) {
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(
        `${getApiUrl()}/api/v1/stores/${storeId}/returns/admin/${returnId}/approve`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (!res.ok) {
        alert('Failed to approve return. Please try again.');
        return;
      }
      fetchReturns();
      fetchStats();
      setShowDetails(false);
    } catch (error) {
      console.error('Failed to approve return:', error);
      alert('Failed to approve return. Please try again.');
    }
  }

  async function handleReject(returnId: string) {
    const reason = prompt('Enter rejection reason:');
    if (!reason) return;
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(
        `${getApiUrl()}/api/v1/stores/${storeId}/returns/admin/${returnId}/reject`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ reason }),
        }
      );
      if (!res.ok) {
        alert('Failed to reject return. Please try again.');
        return;
      }
      fetchReturns();
      fetchStats();
      setShowDetails(false);
    } catch (error) {
      console.error('Failed to reject return:', error);
      alert('Failed to reject return. Please try again.');
    }
  }

  async function handleReceived(returnId: string) {
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(
        `${getApiUrl()}/api/v1/stores/${storeId}/returns/admin/${returnId}/received`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (!res.ok) {
        alert('Failed to mark return as received. Please try again.');
        return;
      }
      fetchReturns();
      fetchStats();
      setShowDetails(false);
    } catch (error) {
      console.error('Failed to mark as received:', error);
      alert('Failed to mark return as received. Please try again.');
    }
  }

  async function handleComplete(returnId: string) {
    const refundMethod = prompt('Enter refund method (original, store_credit, bank_transfer):');
    if (!refundMethod) return;
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(
        `${getApiUrl()}/api/v1/stores/${storeId}/returns/admin/${returnId}/complete`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ refundMethod }),
        }
      );
      if (!res.ok) {
        alert('Failed to complete return. Please try again.');
        return;
      }
      fetchReturns();
      fetchStats();
      setShowDetails(false);
    } catch (error) {
      console.error('Failed to complete return:', error);
      alert('Failed to complete return. Please try again.');
    }
  }

  return (
    <AdminLayout title="Returns & Exchanges" subtitle="Manage return requests and refunds">
      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-white rounded-xl border p-4 shadow-sm">
            <p className="text-sm text-gray-500">Total Returns</p>
            <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
          </div>
          <div className="bg-white rounded-xl border p-4 shadow-sm">
            <p className="text-sm text-gray-500">Pending</p>
            <p className="text-2xl font-bold text-yellow-600">{stats.pending}</p>
          </div>
          <div className="bg-white rounded-xl border p-4 shadow-sm">
            <p className="text-sm text-gray-500">Approved</p>
            <p className="text-2xl font-bold text-blue-600">{stats.approved}</p>
          </div>
          <div className="bg-white rounded-xl border p-4 shadow-sm">
            <p className="text-sm text-gray-500">Completed</p>
            <p className="text-2xl font-bold text-green-600">{stats.completed}</p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="mb-6 flex gap-2">
        {(['all', 'pending', 'approved', 'completed'] as const).map(f => (
          <Button
            key={f}
            variant={filter === f ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(f)}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </Button>
        ))}
      </div>

      {/* Returns List */}
      <div className="rounded-xl border bg-white shadow-sm">
        {isLoading ? (
          <div className="p-8 text-center text-gray-500">Loading returns...</div>
        ) : returns.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No returns found</div>
        ) : (
          <div className="divide-y">
            {returns.map(ret => (
              <div
                key={ret.id}
                className="p-6 hover:bg-gray-50 cursor-pointer"
                onClick={() => {
                  setSelectedReturn(ret);
                  setShowDetails(true);
                }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="font-semibold text-gray-900">#{ret.returnNumber}</span>
                      <Badge className={statusColors[ret.status] || 'bg-gray-100 text-gray-800'}>
                        {ret.status}
                      </Badge>
                      <Badge variant="outline">{typeLabels[ret.type] || ret.type}</Badge>
                    </div>
                    <p className="text-sm text-gray-600 mb-2">
                      <span className="font-medium">Order:</span> #{ret.order.orderNumber} |
                      <span className="font-medium ml-2">Customer:</span> {ret.customer.firstName}{' '}
                      {ret.customer.lastName}
                    </p>
                    <p className="text-sm text-gray-500">
                      <span className="font-medium">Reason:</span> {ret.reason}
                    </p>
                    <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                      <span>{formatDate(ret.createdAt)}</span>
                      <span>{ret.items.length} item(s)</span>
                      <span className="font-medium text-gray-700">
                        {formatCurrency(ret.refundAmount)}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {ret.status === 'pending' && (
                      <>
                        <Button
                          size="sm"
                          onClick={e => {
                            e.stopPropagation();
                            handleApprove(ret.id);
                          }}
                        >
                          Approve
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={e => {
                            e.stopPropagation();
                            handleReject(ret.id);
                          }}
                        >
                          Reject
                        </Button>
                      </>
                    )}
                    {ret.status === 'approved' && (
                      <Button
                        size="sm"
                        onClick={e => {
                          e.stopPropagation();
                          handleReceived(ret.id);
                        }}
                      >
                        Mark Received
                      </Button>
                    )}
                    {(ret.status === 'received' || ret.status === 'inspecting') && (
                      <Button
                        size="sm"
                        onClick={e => {
                          e.stopPropagation();
                          handleComplete(ret.id);
                        }}
                      >
                        Complete & Refund
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Pagination */}
        {meta.totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-6 py-3">
            <p className="text-sm text-gray-500">
              Showing {(meta.page - 1) * meta.limit + 1} to{' '}
              {Math.min(meta.page * meta.limit, meta.total)} of {meta.total} returns
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={meta.page === 1}
                onClick={() => setMeta(prev => ({ ...prev, page: prev.page - 1 }))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={meta.page === meta.totalPages}
                onClick={() => setMeta(prev => ({ ...prev, page: prev.page + 1 }))}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Details Modal */}
      {showDetails && selectedReturn && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setShowDetails(false)}
        >
          <div
            className="bg-white rounded-xl shadow-lg max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b p-4">
              <div>
                <h2 className="font-semibold text-gray-900">
                  Return #{selectedReturn.returnNumber}
                </h2>
                <p className="text-sm text-gray-500">Order #{selectedReturn.order.orderNumber}</p>
              </div>
              <button
                onClick={() => setShowDetails(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            <div className="p-6 space-y-6">
              {/* Status & Type */}
              <div className="flex items-center gap-3">
                <Badge
                  className={statusColors[selectedReturn.status] || 'bg-gray-100 text-gray-800'}
                >
                  {selectedReturn.status}
                </Badge>
                <Badge variant="outline">
                  {typeLabels[selectedReturn.type] || selectedReturn.type}
                </Badge>
              </div>

              {/* Customer Info */}
              <div>
                <h3 className="font-medium text-gray-900 mb-2">Customer</h3>
                <p className="text-sm text-gray-600">
                  {selectedReturn.customer.firstName} {selectedReturn.customer.lastName}
                </p>
                <p className="text-sm text-gray-500">{selectedReturn.customer.email}</p>
              </div>

              {/* Reason */}
              <div>
                <h3 className="font-medium text-gray-900 mb-2">Reason</h3>
                <p className="text-sm text-gray-600">{selectedReturn.reason}</p>
                {selectedReturn.reasonDetail && (
                  <p className="text-sm text-gray-500 mt-1">{selectedReturn.reasonDetail}</p>
                )}
              </div>

              {/* Items */}
              <div>
                <h3 className="font-medium text-gray-900 mb-2">Items</h3>
                <div className="space-y-2">
                  {selectedReturn.items.map(item => (
                    <div
                      key={item.id}
                      className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg"
                    >
                      {item.product?.images?.[0]?.url ? (
                        <img
                          src={item.product.images[0].url}
                          alt=""
                          className="w-12 h-12 rounded object-cover"
                        />
                      ) : (
                        <div className="w-12 h-12 rounded bg-gray-200 flex items-center justify-center">
                          <svg
                            className="w-6 h-6 text-gray-400"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                            />
                          </svg>
                        </div>
                      )}
                      <div className="flex-1">
                        <p className="font-medium text-gray-900">{item.productName}</p>
                        <p className="text-sm text-gray-500">
                          Qty: {item.quantity} | Condition: {item.condition || 'N/A'}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Refund Info */}
              <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                <span className="font-medium text-gray-900">Refund Amount</span>
                <span className="text-lg font-bold text-orange-600">
                  {formatCurrency(selectedReturn.refundAmount)}
                </span>
              </div>

              {/* Actions */}
              <div className="flex gap-3 pt-4 border-t">
                {selectedReturn.status === 'pending' && (
                  <>
                    <Button className="flex-1" onClick={() => handleApprove(selectedReturn.id)}>
                      Approve Return
                    </Button>
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={() => handleReject(selectedReturn.id)}
                    >
                      Reject
                    </Button>
                  </>
                )}
                {selectedReturn.status === 'approved' && (
                  <Button className="flex-1" onClick={() => handleReceived(selectedReturn.id)}>
                    Mark as Received
                  </Button>
                )}
                {(selectedReturn.status === 'received' ||
                  selectedReturn.status === 'inspecting') && (
                  <Button className="flex-1" onClick={() => handleComplete(selectedReturn.id)}>
                    Complete & Process Refund
                  </Button>
                )}
                <Button variant="outline" onClick={() => setShowDetails(false)}>
                  Close
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
