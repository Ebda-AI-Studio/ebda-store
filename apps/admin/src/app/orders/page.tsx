'use client';

import { useState } from 'react';
import { Button, Input, Badge, Modal, Select } from '@force/ui';
import { AdminLayout } from '../../components/AdminLayout';

// Demo orders data
const initialOrders = [
  {
    id: 'ORD-001',
    customer: { name: 'John Doe', email: 'john@example.com' },
    items: [
      { name: 'Premium Wireless Headphones', quantity: 1, price: 29900 },
    ],
    total: 32890,
    status: 'delivered',
    paymentStatus: 'paid',
    createdAt: '2024-12-24T10:30:00Z',
    shippingAddress: '123 Main St, New York, NY 10001',
  },
  {
    id: 'ORD-002',
    customer: { name: 'Jane Smith', email: 'jane@example.com' },
    items: [
      { name: 'Smart Watch Pro', quantity: 1, price: 39900 },
      { name: 'USB-C Hub 7-in-1', quantity: 2, price: 7900 },
    ],
    total: 61270,
    status: 'shipped',
    paymentStatus: 'paid',
    createdAt: '2024-12-23T15:45:00Z',
    shippingAddress: '456 Oak Ave, Los Angeles, CA 90001',
  },
  {
    id: 'ORD-003',
    customer: { name: 'Bob Wilson', email: 'bob@example.com' },
    items: [
      { name: 'Wireless Mechanical Keyboard', quantity: 1, price: 14900 },
    ],
    total: 16390,
    status: 'processing',
    paymentStatus: 'paid',
    createdAt: '2024-12-23T09:20:00Z',
    shippingAddress: '789 Pine Rd, Chicago, IL 60601',
  },
  {
    id: 'ORD-004',
    customer: { name: 'Alice Brown', email: 'alice@example.com' },
    items: [
      { name: 'Fitness Tracker Band', quantity: 2, price: 9900 },
      { name: 'Ergonomic Mouse', quantity: 1, price: 8900 },
    ],
    total: 31570,
    status: 'pending',
    paymentStatus: 'pending',
    createdAt: '2024-12-22T18:00:00Z',
    shippingAddress: '321 Elm Blvd, Miami, FL 33101',
  },
  {
    id: 'ORD-005',
    customer: { name: 'Charlie Davis', email: 'charlie@example.com' },
    items: [
      { name: '4K Webcam Pro', quantity: 1, price: 19900 },
    ],
    total: 21890,
    status: 'cancelled',
    paymentStatus: 'refunded',
    createdAt: '2024-12-21T11:15:00Z',
    shippingAddress: '654 Maple Dr, Seattle, WA 98101',
  },
];

function formatPrice(cents: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const statusOptions = [
  { value: 'pending', label: 'Pending' },
  { value: 'processing', label: 'Processing' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancelled', label: 'Cancelled' },
];

export default function OrdersPage() {
  const [orders, setOrders] = useState(initialOrders);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedOrder, setSelectedOrder] = useState<typeof initialOrders[0] | null>(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);

  const filteredOrders = orders.filter(order => {
    const matchesSearch = order.id.toLowerCase().includes(search.toLowerCase()) ||
                         order.customer.name.toLowerCase().includes(search.toLowerCase()) ||
                         order.customer.email.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === 'all' || order.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'delivered':
        return <Badge className="bg-green-100 text-green-700">Delivered</Badge>;
      case 'shipped':
        return <Badge className="bg-blue-100 text-blue-700">Shipped</Badge>;
      case 'processing':
        return <Badge className="bg-yellow-100 text-yellow-700">Processing</Badge>;
      case 'pending':
        return <Badge variant="secondary">Pending</Badge>;
      case 'cancelled':
        return <Badge variant="destructive">Cancelled</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const getPaymentBadge = (status: string) => {
    switch (status) {
      case 'paid':
        return <Badge className="bg-green-100 text-green-700">Paid</Badge>;
      case 'pending':
        return <Badge className="bg-yellow-100 text-yellow-700">Pending</Badge>;
      case 'refunded':
        return <Badge className="bg-gray-100 text-gray-700">Refunded</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const viewOrderDetails = (order: typeof initialOrders[0]) => {
    setSelectedOrder(order);
    setIsDetailModalOpen(true);
  };

  const updateOrderStatus = (orderId: string, newStatus: string) => {
    setOrders(prev =>
      prev.map(order =>
        order.id === orderId ? { ...order, status: newStatus } : order
      )
    );
  };

  // Stats
  const stats = {
    total: orders.length,
    pending: orders.filter(o => o.status === 'pending').length,
    processing: orders.filter(o => o.status === 'processing').length,
    shipped: orders.filter(o => o.status === 'shipped').length,
    delivered: orders.filter(o => o.status === 'delivered').length,
  };

  return (
    <AdminLayout
      title="Orders"
      subtitle={`${stats.total} total orders`}
    >
      {/* Stats */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-sm text-gray-500">Pending</p>
          <p className="text-2xl font-bold text-yellow-600">{stats.pending}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-sm text-gray-500">Processing</p>
          <p className="text-2xl font-bold text-blue-600">{stats.processing}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-sm text-gray-500">Shipped</p>
          <p className="text-2xl font-bold text-purple-600">{stats.shipped}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-sm text-gray-500">Delivered</p>
          <p className="text-2xl font-bold text-green-600">{stats.delivered}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {['all', 'pending', 'processing', 'shipped', 'delivered', 'cancelled'].map(status => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
                statusFilter === status
                  ? 'bg-primary text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-100 border'
              }`}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>
        <div className="w-full sm:w-64">
          <Input
            placeholder="Search orders..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Orders Table */}
      <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Order
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Customer
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Items
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Total
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Status
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Payment
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Date
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {filteredOrders.map(order => (
              <tr key={order.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <span className="font-medium text-primary">{order.id}</span>
                </td>
                <td className="px-4 py-3">
                  <div>
                    <p className="font-medium text-gray-900">{order.customer.name}</p>
                    <p className="text-xs text-gray-500">{order.customer.email}</p>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className="text-sm text-gray-600">{order.items.length} items</span>
                </td>
                <td className="px-4 py-3">
                  <span className="font-medium text-gray-900">{formatPrice(order.total)}</span>
                </td>
                <td className="px-4 py-3">{getStatusBadge(order.status)}</td>
                <td className="px-4 py-3">{getPaymentBadge(order.paymentStatus)}</td>
                <td className="px-4 py-3">
                  <span className="text-sm text-gray-500">{formatDate(order.createdAt)}</span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => viewOrderDetails(order)}>
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {filteredOrders.length === 0 && (
          <div className="py-12 text-center">
            <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            <h3 className="mt-4 text-sm font-medium text-gray-900">No orders found</h3>
            <p className="mt-1 text-sm text-gray-500">Try adjusting your search or filter criteria.</p>
          </div>
        )}
      </div>

      {/* Order Detail Modal */}
      <Modal
        isOpen={isDetailModalOpen}
        onClose={() => setIsDetailModalOpen(false)}
        title={`Order ${selectedOrder?.id}`}
      >
        {selectedOrder && (
          <div className="space-y-6">
            {/* Customer Info */}
            <div>
              <h4 className="text-sm font-medium text-gray-500 mb-2">Customer</h4>
              <p className="font-medium text-gray-900">{selectedOrder.customer.name}</p>
              <p className="text-sm text-gray-600">{selectedOrder.customer.email}</p>
            </div>

            {/* Shipping Address */}
            <div>
              <h4 className="text-sm font-medium text-gray-500 mb-2">Shipping Address</h4>
              <p className="text-sm text-gray-600">{selectedOrder.shippingAddress}</p>
            </div>

            {/* Items */}
            <div>
              <h4 className="text-sm font-medium text-gray-500 mb-2">Items</h4>
              <div className="space-y-2">
                {selectedOrder.items.map((item, index) => (
                  <div key={index} className="flex justify-between text-sm">
                    <span className="text-gray-600">
                      {item.name} x {item.quantity}
                    </span>
                    <span className="font-medium">{formatPrice(item.price * item.quantity)}</span>
                  </div>
                ))}
                <div className="border-t pt-2 flex justify-between">
                  <span className="font-medium text-gray-900">Total</span>
                  <span className="font-bold text-primary">{formatPrice(selectedOrder.total)}</span>
                </div>
              </div>
            </div>

            {/* Status Update */}
            <div>
              <h4 className="text-sm font-medium text-gray-500 mb-2">Update Status</h4>
              <Select
                value={selectedOrder.status}
                onChange={e => {
                  updateOrderStatus(selectedOrder.id, e.target.value);
                  setSelectedOrder({ ...selectedOrder, status: e.target.value });
                }}
                options={statusOptions}
              />
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button variant="outline" onClick={() => setIsDetailModalOpen(false)}>
                Close
              </Button>
              <Button>
                Print Invoice
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </AdminLayout>
  );
}
