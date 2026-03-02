'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useStoreUrl } from '../../contexts/StoreContext';

interface Order {
  id: string;
  orderNumber: string;
  status: string;
  total: number;
  createdAt: string;
}

export default function AccountDashboard() {
  const storeUrl = useStoreUrl();
  const [recentOrders, setRecentOrders] = useState<Order[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchOrders();
  }, []);

  async function fetchOrders() {
    setError(null);
    try {
      const result = await api.getOrders();
      if (result.success && result.data) {
        setRecentOrders(result.data.orders.slice(0, 3));
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
      month: 'short',
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Account Dashboard</h1>
        <p className="mt-1 text-muted-foreground">Manage your account and view your orders</p>
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

      {/* Quick Stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-blue-100">
              <svg
                className="h-6 w-6 text-blue-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                />
              </svg>
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{recentOrders.length}</p>
              <p className="text-sm text-muted-foreground">Total Orders</p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-green-100">
              <svg
                className="h-6 w-6 text-green-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">0</p>
              <p className="text-sm text-muted-foreground">Saved Addresses</p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-purple-100">
              <svg
                className="h-6 w-6 text-purple-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
                />
              </svg>
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">0</p>
              <p className="text-sm text-muted-foreground">Wishlist Items</p>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Orders */}
      <div className="rounded-xl border bg-white shadow-sm">
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="font-semibold text-foreground">Recent Orders</h2>
          <Link href={storeUrl('/account/orders')} className="text-sm text-primary hover:underline">
            View All
          </Link>
        </div>

        {isLoading ? (
          <div className="p-8 text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : recentOrders.length > 0 ? (
          <div className="divide-y">
            {recentOrders.map(order => (
              <div key={order.id} className="flex items-center justify-between p-4">
                <div>
                  <p className="font-medium text-foreground">#{order.orderNumber}</p>
                  <p className="text-sm text-muted-foreground">{formatDate(order.createdAt)}</p>
                </div>
                <div className="text-right">
                  <span
                    className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusColors[order.status] || 'bg-muted text-foreground'}`}
                  >
                    {order.status}
                  </span>
                  <p className="mt-1 font-medium text-foreground">{formatPrice(order.total)}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-8 text-center">
            <svg
              className="mx-auto h-12 w-12 text-muted-foreground/70"
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
            <p className="mt-4 text-muted-foreground">No orders yet</p>
            <Link
              href={storeUrl('/products')}
              className="mt-2 inline-block text-primary hover:underline"
            >
              Start shopping
            </Link>
          </div>
        )}
      </div>

      {/* Quick Actions */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href={storeUrl('/account/addresses')}
          className="flex items-center gap-4 rounded-xl border bg-white p-4 shadow-sm transition hover:border-primary hover:shadow-md"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100">
            <svg
              className="h-5 w-5 text-green-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </div>
          <div>
            <p className="font-medium text-foreground">Add Address</p>
            <p className="text-sm text-muted-foreground">Save a new delivery address</p>
          </div>
        </Link>

        <Link
          href={storeUrl('/account/settings')}
          className="flex items-center gap-4 rounded-xl border bg-white p-4 shadow-sm transition hover:border-primary hover:shadow-md"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100">
            <svg
              className="h-5 w-5 text-blue-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </div>
          <div>
            <p className="font-medium text-foreground">Account Settings</p>
            <p className="text-sm text-muted-foreground">Update your profile and password</p>
          </div>
        </Link>
      </div>
    </div>
  );
}
