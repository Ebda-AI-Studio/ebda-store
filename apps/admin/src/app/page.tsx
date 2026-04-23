'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Badge } from '@force/ui';
import { AdminLayout } from '../components/AdminLayout';
import { formatPrice, formatDate, formatNumber } from '../lib/format';
import { apiGet } from '../lib/api';
import { useStore } from '../contexts/StoreContext';

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

export default function DashboardPage() {
  const { selectedStoreId, stores: globalStores } = useStore();
  const storeName =
    selectedStoreId !== 'all' ? globalStores.find(s => s.id === selectedStoreId)?.name : null;
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [recentStores, setRecentStores] = useState<RecentStore[]>([]);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    async function fetchData() {
      try {
        setIsLoading(true);
        setHasError(false);
        const params = new URLSearchParams();
        if (selectedStoreId !== 'all') params.append('storeId', selectedStoreId);
        const qs = params.toString() ? `?${params}` : '';
        const { data } = await apiGet<{
          stats: PlatformStats;
          recentStores: RecentStore[];
          recentOrders: RecentOrder[];
        }>(`/api/v1/admin/dashboard${qs}`);
        if (data) {
          setStats(data.stats);
          setRecentStores(data.recentStores || []);
          setRecentOrders(data.recentOrders || []);
        }
      } catch (error) {
        console.error('Failed to fetch dashboard data:', error);
        setHasError(true);
      } finally {
        setIsLoading(false);
      }
    }
    fetchData();
  }, [selectedStoreId]);

  const statCards = [
    {
      name: 'Total Stores',
      value: stats?.stores || 0,
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
          />
        </svg>
      ),
      color: 'from-blue-500 to-blue-600',
      bgColor: 'bg-info/5',
      iconBg: 'bg-info',
    },
    {
      name: 'Total Users',
      value: stats?.users || 0,
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
          />
        </svg>
      ),
      color: 'from-emerald-500 to-emerald-600',
      bgColor: 'bg-emerald-50',
      iconBg: 'bg-emerald-500',
    },
    {
      name: 'Total Orders',
      value: stats?.orders || 0,
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
          />
        </svg>
      ),
      color: 'from-violet-500 to-violet-600',
      bgColor: 'bg-violet-50',
      iconBg: 'bg-violet-500',
    },
    {
      name: 'Total Revenue',
      value: formatPrice(stats?.revenue || 0),
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      ),
      color: 'from-primary to-primary/90',
      bgColor: 'bg-primary/5',
      iconBg: 'bg-primary',
      isRevenue: true,
    },
  ];

  const quickActions = [
    {
      title: 'Create Store',
      description: 'Provision a new store',
      href: '/stores/new',
      icon: (
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      ),
      iconBg: 'bg-info/10 text-info dark:bg-info/30 dark:text-info',
    },
    {
      title: 'Manage Users',
      description: 'View all platform users',
      href: '/users',
      icon: (
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
          />
        </svg>
      ),
      iconBg: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300',
    },
    {
      title: 'Audit Logs',
      description: 'View system activity',
      href: '/audit-logs',
      icon: (
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
      ),
      iconBg: 'bg-violet-100 text-violet-600',
    },
    {
      title: 'All Stores',
      description: 'Manage all stores',
      href: '/stores',
      icon: (
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
          />
        </svg>
      ),
      iconBg: 'bg-muted text-muted-foreground',
    },
  ];

  if (hasError) {
    return (
      <AdminLayout
        title="Platform Dashboard"
        subtitle="Overview of all stores and platform metrics"
      >
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <p className="text-muted-foreground mb-4">Failed to load dashboard data.</p>
          <button
            onClick={() => {
              setHasError(false);
              setIsLoading(true);
            }}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer"
          >
            Retry
          </button>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title="Platform Dashboard"
      subtitle={
        storeName ? `Overview for ${storeName}` : 'Overview of all stores and platform metrics'
      }
      actions={
        <Link href="/stores/new">
          <Button size="sm" className="gap-2 shadow-lg shadow-primary/25">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            New Store
          </Button>
        </Link>
      }
    >
      {/* Stats Grid */}
      {isLoading ? (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="force-stat-card">
              <div className="flex items-start justify-between">
                <div className="flex-1 space-y-3">
                  <div className="h-3 w-24 force-skeleton" />
                  <div className="h-8 w-32 force-skeleton" />
                  <div className="h-3 w-16 force-skeleton" />
                </div>
                <div className="h-12 w-12 rounded-2xl force-skeleton" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4 stagger-animation">
          {statCards.map((stat, index) => (
            <div
              key={stat.name}
              className="force-stat-card"
              style={{ animationDelay: `${index * 0.1}s` }}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <p className="text-sm font-medium text-muted-foreground">{stat.name}</p>
                  <div className="mt-2">
                    <p className="text-3xl font-bold tracking-tight text-foreground">
                      {stat.isRevenue ? stat.value : formatNumber(stat.value as number)}
                    </p>
                  </div>
                </div>
                <div
                  className={`flex h-12 w-12 items-center justify-center rounded-2xl ${stat.iconBg} text-white shadow-lg`}
                >
                  {stat.icon}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Recent Activity Section */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {/* Recent Stores */}
        <div className="force-card animate-slide-up p-0" style={{ animationDelay: '0.2s' }}>
          <div className="flex items-center justify-between border-b px-6 py-4">
            <div>
              <h2 className="font-semibold text-foreground">Recent Stores</h2>
              <p className="text-xs text-muted-foreground">Latest store registrations</p>
            </div>
            <Link
              href="/stores"
              className="text-sm font-medium text-primary hover:text-primary/80 transition-colors"
            >
              View all →
            </Link>
          </div>
          <div className="divide-y divide-border/50">
            {isLoading ? (
              <div className="space-y-4 p-6">
                {[1, 2, 3].map(i => (
                  <div key={i} className="flex items-center gap-4">
                    <div className="h-10 w-10 rounded-xl force-skeleton" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 w-32 force-skeleton" />
                      <div className="h-3 w-48 force-skeleton" />
                    </div>
                  </div>
                ))}
              </div>
            ) : recentStores.length > 0 ? (
              recentStores.map(store => (
                <Link
                  key={store.id}
                  href={`/stores/${store.id}`}
                  className="flex items-center justify-between px-6 py-4 transition-colors hover:bg-muted/30 cursor-pointer"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary/20 to-primary/10 font-bold text-primary">
                      {store.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="font-medium text-foreground">{store.name}</p>
                      <p className="text-sm text-muted-foreground">{store.owner?.email}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <Badge
                      variant={store.status === 'active' ? 'default' : 'secondary'}
                      className="capitalize"
                    >
                      {store.status}
                    </Badge>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDate(store.createdAt)}
                    </p>
                  </div>
                </Link>
              ))
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
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
                      d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
                    />
                  </svg>
                </div>
                <p className="font-medium text-foreground">No stores yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Create your first store to get started
                </p>
                <Link href="/stores/new" className="mt-4">
                  <Button size="sm" variant="outline">
                    Create Store
                  </Button>
                </Link>
              </div>
            )}
          </div>
        </div>

        {/* Recent Orders */}
        <div className="force-card animate-slide-up p-0" style={{ animationDelay: '0.3s' }}>
          <div className="flex items-center justify-between border-b px-6 py-4">
            <div>
              <h2 className="font-semibold text-foreground">Recent Orders</h2>
              <p className="text-xs text-muted-foreground">{storeName || 'Across all stores'}</p>
            </div>
            <Link
              href="/stores"
              className="text-sm font-medium text-primary hover:text-primary/80 transition-colors"
            >
              View all →
            </Link>
          </div>
          <div className="divide-y divide-border/50">
            {isLoading ? (
              <div className="space-y-4 p-6">
                {[1, 2, 3].map(i => (
                  <div key={i} className="flex items-center gap-4">
                    <div className="h-10 w-10 rounded-xl force-skeleton" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 w-32 force-skeleton" />
                      <div className="h-3 w-48 force-skeleton" />
                    </div>
                  </div>
                ))}
              </div>
            ) : recentOrders.length > 0 ? (
              recentOrders.map(order => (
                <div
                  key={order.id}
                  className="flex items-center justify-between px-6 py-4 transition-colors hover:bg-muted/30"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/20 to-violet-500/10">
                      <svg
                        className="h-5 w-5 text-violet-600"
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
                    <div>
                      <p className="font-medium text-foreground">
                        {order.orderNumber || `#${order.id.slice(0, 8).toUpperCase()}`}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {order.customer?.firstName} {order.customer?.lastName} • {order.store?.name}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-primary">{formatPrice(order.total)}</p>
                    <Badge
                      variant={
                        order.status === 'paid' || order.status === 'completed'
                          ? 'default'
                          : order.status === 'processing'
                            ? 'secondary'
                            : 'destructive'
                      }
                      className="mt-1 capitalize"
                    >
                      {order.status}
                    </Badge>
                  </div>
                </div>
              ))
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
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
                <p className="font-medium text-foreground">No orders yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Orders will appear here when customers make purchases
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="mt-8 animate-slide-up" style={{ animationDelay: '0.4s' }}>
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-foreground">Quick Actions</h2>
          <p className="text-sm text-muted-foreground">Common platform management tasks</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {quickActions.map((action, index) => (
            <Link
              key={action.title}
              href={action.href}
              className="group force-card flex items-center gap-4 p-4"
              style={{ animationDelay: `${0.5 + index * 0.05}s` }}
            >
              <div
                className={`flex h-12 w-12 items-center justify-center rounded-xl ${action.iconBg} transition-transform group-hover:scale-110`}
              >
                {action.icon}
              </div>
              <div>
                <p className="font-medium text-foreground group-hover:text-primary transition-colors">
                  {action.title}
                </p>
                <p className="text-xs text-muted-foreground">{action.description}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </AdminLayout>
  );
}
