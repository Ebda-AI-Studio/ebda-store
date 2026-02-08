'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';

interface Order {
  id: string;
  orderNumber: string;
  status: string;
  total: number;
  createdAt: string;
  items: {
    id: string;
    productId?: string;
    quantity: number;
    price: number;
    product?: {
      name: string;
      images: Array<{ id: string; url: string; alt?: string }>;
    };
  }[];
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchOrders();
  }, []);

  async function fetchOrders() {
    setError(null);
    setIsLoading(true);
    try {
      const result = await api.getOrders();
      if (result.success && result.data) {
        setOrders(result.data.orders);
      } else if (result.error) {
        setError(result.error.message || 'Failed to load orders');
      }
    } catch (err) {
      console.error('Failed to fetch orders:', err);
      setError('Unable to load orders. Please check your connection.');
    } finally {
      setIsLoading(false);
    }
  }

  function formatDate(date: string) {
    return new Date(date).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }

  function formatPrice(fils: number) {
    return new Intl.NumberFormat('en-KW', {
      style: 'currency',
      currency: 'KWD',
    }).format(fils / 1000);
  }

  const statusColors: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-800',
    processing: 'bg-blue-100 text-blue-800',
    shipped: 'bg-purple-100 text-purple-800',
    delivered: 'bg-green-100 text-green-800',
    cancelled: 'bg-red-100 text-red-800',
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Order History</h1>
          <p className="mt-1 text-gray-500">View and track your orders</p>
        </div>
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Order History</h1>
        <p className="mt-1 text-gray-500">View and track your orders</p>
      </div>

      {/* Error Display */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <div className="flex items-center gap-3">
            <svg
              className="h-5 w-5 text-red-500 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <p className="text-red-700 flex-1">{error}</p>
            <button
              onClick={() => fetchOrders()}
              className="px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {!error && orders.length > 0 ? (
        <div className="space-y-4">
          {orders.map(order => (
            <div key={order.id} className="rounded-xl border bg-white shadow-sm overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b bg-gray-50 p-4">
                <div className="flex flex-wrap items-center gap-4">
                  <div>
                    <p className="text-sm text-gray-500">Order Number</p>
                    <p className="font-medium text-gray-900">#{order.orderNumber}</p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">Date</p>
                    <p className="font-medium text-gray-900">{formatDate(order.createdAt)}</p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">Total</p>
                    <p className="font-medium text-gray-900">{formatPrice(order.total)}</p>
                  </div>
                </div>
                <span
                  className={`inline-flex rounded-full px-3 py-1 text-sm font-medium ${statusColors[order.status] || 'bg-gray-100 text-gray-800'}`}
                >
                  {order.status.charAt(0).toUpperCase() + order.status.slice(1)}
                </span>
              </div>

              <div className="p-4">
                {order.items && order.items.length > 0 ? (
                  <div className="space-y-4">
                    {order.items.map(item => (
                      <div key={item.id} className="flex items-center gap-4">
                        <div className="h-16 w-16 flex-shrink-0 rounded-lg bg-gray-100">
                          {item.product?.images?.[0]?.url ? (
                            <img
                              src={item.product.images[0].url}
                              alt={item.product?.name || 'Product'}
                              className="h-full w-full rounded-lg object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-gray-400">
                              <svg
                                className="h-6 w-6"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={1}
                                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                                />
                              </svg>
                            </div>
                          )}
                        </div>
                        <div className="flex-1">
                          <p className="font-medium text-gray-900">
                            {item.product?.name || 'Product'}
                          </p>
                          <p className="text-sm text-gray-500">Qty: {item.quantity}</p>
                        </div>
                        <p className="font-medium text-gray-900">{formatPrice(item.price)}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">No items in this order</p>
                )}
              </div>

              <div className="flex justify-end gap-2 border-t bg-gray-50 p-4">
                <button className="rounded-lg border bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                  Track Order
                </button>
                <button className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90">
                  View Details
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : !error ? (
        <div className="rounded-xl border bg-white p-12 text-center shadow-sm">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1}
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
            />
          </svg>
          <h3 className="mt-4 text-lg font-medium text-gray-900">No orders yet</h3>
          <p className="mt-2 text-gray-500">When you place orders, they will appear here.</p>
          <Link
            href="/products"
            className="mt-6 inline-flex items-center rounded-lg bg-primary px-6 py-3 font-medium text-white hover:bg-primary/90"
          >
            Start Shopping
          </Link>
        </div>
      ) : null}
    </div>
  );
}
