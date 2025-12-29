'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Badge } from '@force/ui';
import { AdminLayout } from '../components/AdminLayout';

interface PlatformStats {
  stores: number;
  users: number;
  orders: number;
  revenue: number;
}

interface RecentStore {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  owner: { email: string };
}

interface RecentOrder {
  id: string;
  orderNumber: string;
  total: number;
  status: string;
  createdAt: string;
  customer: { email: string; firstName: string; lastName: string };
  store: { name: string };
}

function formatPrice(cents: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

function formatDate(date: string) {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function DashboardPage() {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [recentStores, setRecentStores] = useState<RecentStore[]>([]);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [, setIsLoading] = useState(true);

  useEffect(() => {
    // Fetch platform stats from API
    async function fetchData() {
      try {
        const token = localStorage.getItem('authToken');
        const response = await fetch('http://localhost:4000/api/v1/admin/dashboard', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) {
          const data = await response.json();
          setStats(data.data.stats);
          setRecentStores(data.data.recentStores || []);
          setRecentOrders(data.data.recentOrders || []);
        }
      } catch (error) {
        console.error('Failed to fetch dashboard data:', error);
      } finally {
        setIsLoading(false);
      }
    }
    fetchData();
  }, []);

  const statCards = [
    { name: 'Total Stores', value: stats?.stores || 0, icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4', color: 'bg-blue-500' },
    { name: 'Total Users', value: stats?.users || 0, icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z', color: 'bg-green-500' },
    { name: 'Total Orders', value: stats?.orders || 0, icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2', color: 'bg-purple-500' },
    { name: 'Total Revenue', value: formatPrice(stats?.revenue || 0), icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z', color: 'bg-primary' },
  ];

  return (
    <AdminLayout
      title="Platform Dashboard"
      subtitle="Overview of all stores and platform metrics"
      actions={
        <Link href="/stores/new">
          <Button size="sm">
            <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Store
          </Button>
        </Link>
      }
    >
      {/* Stats Grid */}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {statCards.map((stat) => (
          <div key={stat.name} className="rounded-xl border bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">{stat.name}</p>
                <p className="mt-1 text-2xl font-bold text-gray-900">{stat.value}</p>
              </div>
              <div className={`flex h-12 w-12 items-center justify-center rounded-lg ${stat.color}`}>
                <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={stat.icon} />
                </svg>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Recent Stores & Orders */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {/* Recent Stores */}
        <div className="rounded-xl border bg-white shadow-sm">
          <div className="flex items-center justify-between border-b p-4">
            <h2 className="font-semibold text-gray-900">Recent Stores</h2>
            <Link href="/stores" className="text-sm text-primary hover:underline">
              View all
            </Link>
          </div>
          <div className="divide-y">
            {recentStores.length > 0 ? recentStores.map((store) => (
              <div key={store.id} className="flex items-center justify-between p-4">
                <div>
                  <p className="font-medium text-gray-900">{store.name}</p>
                  <p className="text-sm text-gray-500">{store.owner?.email}</p>
                </div>
                <div className="text-right">
                  <Badge variant={store.status === 'active' ? 'default' : 'secondary'}>
                    {store.status}
                  </Badge>
                  <p className="mt-1 text-xs text-gray-400">{formatDate(store.createdAt)}</p>
                </div>
              </div>
            )) : (
              <div className="p-8 text-center text-gray-500">
                <p>No stores yet</p>
                <Link href="/stores/new" className="mt-2 inline-block text-primary hover:underline">
                  Create your first store
                </Link>
              </div>
            )}
          </div>
        </div>

        {/* Recent Orders */}
        <div className="rounded-xl border bg-white shadow-sm">
          <div className="flex items-center justify-between border-b p-4">
            <h2 className="font-semibold text-gray-900">Recent Orders</h2>
            <span className="text-sm text-gray-500">Across all stores</span>
          </div>
          <div className="divide-y">
            {recentOrders.length > 0 ? recentOrders.map((order) => (
              <div key={order.id} className="flex items-center justify-between p-4">
                <div>
                  <p className="font-medium text-gray-900">{order.orderNumber || `#${order.id.slice(0, 8)}`}</p>
                  <p className="text-sm text-gray-500">
                    {order.customer?.firstName} {order.customer?.lastName} - {order.store?.name}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-primary">{formatPrice(order.total)}</p>
                  <Badge
                    variant={
                      order.status === 'paid' ? 'default' :
                      order.status === 'processing' ? 'secondary' : 'destructive'
                    }
                    className="mt-1"
                  >
                    {order.status}
                  </Badge>
                </div>
              </div>
            )) : (
              <div className="p-8 text-center text-gray-500">
                <p>No orders yet</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="mt-8">
        <h2 className="mb-4 font-semibold text-gray-900">Quick Actions</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Link
            href="/stores/new"
            className="flex items-center gap-3 rounded-xl border bg-white p-4 shadow-sm transition hover:border-primary hover:shadow-md"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100">
              <svg className="h-5 w-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </div>
            <div>
              <p className="font-medium text-gray-900">Create Store</p>
              <p className="text-xs text-gray-500">Provision a new store</p>
            </div>
          </Link>

          <Link
            href="/users"
            className="flex items-center gap-3 rounded-xl border bg-white p-4 shadow-sm transition hover:border-primary hover:shadow-md"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100">
              <svg className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            </div>
            <div>
              <p className="font-medium text-gray-900">Manage Users</p>
              <p className="text-xs text-gray-500">View all platform users</p>
            </div>
          </Link>

          <Link
            href="/audit-logs"
            className="flex items-center gap-3 rounded-xl border bg-white p-4 shadow-sm transition hover:border-primary hover:shadow-md"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-100">
              <svg className="h-5 w-5 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div>
              <p className="font-medium text-gray-900">Audit Logs</p>
              <p className="text-xs text-gray-500">View system activity</p>
            </div>
          </Link>

          <Link
            href="/settings"
            className="flex items-center gap-3 rounded-xl border bg-white p-4 shadow-sm transition hover:border-primary hover:shadow-md"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100">
              <svg className="h-5 w-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <div>
              <p className="font-medium text-gray-900">Settings</p>
              <p className="text-xs text-gray-500">Platform configuration</p>
            </div>
          </Link>
        </div>
      </div>
    </AdminLayout>
  );
}
