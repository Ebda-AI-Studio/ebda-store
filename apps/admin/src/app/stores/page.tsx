'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Button } from '@force/ui';
import { AdminLayout } from '../../components/AdminLayout';
import { ErrorState } from '../../components/ErrorState';

interface Store {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  status: 'active' | 'inactive' | 'suspended';
  plan: 'free' | 'starter' | 'professional' | 'enterprise';
  createdAt: string;
  owner: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  _count?: {
    products: number;
    orders: number;
  };
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

function formatDate(date: string) {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const statusConfig = {
  active: { variant: 'default' as const, bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  inactive: { variant: 'secondary' as const, bg: 'bg-gray-50', text: 'text-gray-600', dot: 'bg-gray-400' },
  suspended: { variant: 'destructive' as const, bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500' },
};

const planConfig = {
  free: { bg: 'bg-gray-100', text: 'text-gray-700', icon: '🆓' },
  starter: { bg: 'bg-blue-50', text: 'text-blue-700', icon: '🚀' },
  professional: { bg: 'bg-violet-50', text: 'text-violet-700', icon: '💼' },
  enterprise: { bg: 'bg-amber-50', text: 'text-amber-700', icon: '👑' },
};

export default function StoresPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 10, total: 0, totalPages: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');

  const fetchStores = useCallback(async () => {
    try {
      setError(null);
      const token = localStorage.getItem('authToken');
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        limit: pagination.limit.toString(),
      });
      if (statusFilter !== 'all') params.append('status', statusFilter);
      if (search) params.append('search', search);

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/v1/admin/stores?${params}`,
        {
          headers: { 'Authorization': `Bearer ${token}` }
        }
      );
      if (response.ok) {
        const data = await response.json();
        setStores(data.data.stores || []);
        setPagination(prev => ({ ...prev, ...data.data.pagination }));
      } else {
        const errorData = await response.json().catch(() => ({}));
        setError(errorData.error?.message || 'Failed to fetch stores');
      }
    } catch (error) {
      console.error('Failed to fetch stores:', error);
      setError('Unable to connect to the server. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  }, [pagination.page, pagination.limit, statusFilter, search]);

  useEffect(() => {
    fetchStores();
  }, [fetchStores]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPagination(prev => ({ ...prev, page: 1 }));
  }

  return (
    <AdminLayout
      title="Stores"
      subtitle={`${pagination.total} stores on the platform`}
      actions={
        <Link href="/stores/new">
          <Button size="sm" className="gap-2 shadow-lg shadow-primary/25">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Create Store
          </Button>
        </Link>
      }
    >
      {/* Filters & View Toggle */}
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <form onSubmit={handleSearch} className="flex flex-1 gap-3">
          <div className="relative flex-1 max-w-md">
            <svg
              className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search by name, slug, or owner..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="force-input pl-11"
            />
          </div>
          <Button type="submit" variant="outline" size="sm" className="rounded-xl px-6">
            Search
          </Button>
        </form>

        <div className="flex items-center gap-3">
          {/* Status Filter Pills */}
          <div className="hidden sm:flex items-center gap-1 rounded-xl bg-muted/50 p-1">
            {['all', 'active', 'inactive', 'suspended'].map((status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                  statusFilter === status
                    ? 'bg-white text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {status === 'all' ? 'All' : status.charAt(0).toUpperCase() + status.slice(1)}
              </button>
            ))}
          </div>

          {/* Mobile Status Dropdown */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-xl border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 sm:hidden"
          >
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="suspended">Suspended</option>
          </select>

          {/* View Toggle */}
          <div className="flex items-center gap-1 rounded-xl bg-muted/50 p-1">
            <button
              onClick={() => setViewMode('grid')}
              className={`rounded-lg p-2 transition-all ${
                viewMode === 'grid' ? 'bg-white text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
              title="Grid view"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
            </button>
            <button
              onClick={() => setViewMode('table')}
              className={`rounded-lg p-2 transition-all ${
                viewMode === 'table' ? 'bg-white text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
              title="Table view"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Error State */}
      {error && !isLoading && (
        <ErrorState
          title="Failed to load stores"
          message={error}
          onRetry={fetchStores}
        />
      )}

      {/* Loading State */}
      {!error && isLoading ? (
        viewMode === 'grid' ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="force-card animate-pulse">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="h-12 w-12 rounded-xl bg-muted" />
                    <div className="space-y-2">
                      <div className="h-4 w-24 rounded bg-muted" />
                      <div className="h-3 w-32 rounded bg-muted" />
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="h-3 w-full rounded bg-muted" />
                  <div className="h-3 w-3/4 rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="force-card p-0 overflow-hidden">
            <div className="space-y-4 p-6">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 animate-pulse">
                  <div className="h-10 w-10 rounded-xl bg-muted" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-32 rounded bg-muted" />
                    <div className="h-3 w-48 rounded bg-muted" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      ) : !error && stores.length > 0 ? (
        <>
          {/* Grid View */}
          {viewMode === 'grid' && (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 stagger-animation">
              {stores.map((store, index) => {
                const status = statusConfig[store.status];
                const plan = planConfig[store.plan];
                return (
                  <Link
                    key={store.id}
                    href={`/stores/${store.id}`}
                    className="force-card group relative overflow-hidden"
                    style={{ animationDelay: `${index * 0.05}s` }}
                  >
                    {/* Status Indicator */}
                    <div className="absolute top-4 right-4">
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${status.bg} ${status.text}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${status.dot} ${store.status === 'active' ? 'animate-pulse' : ''}`} />
                        {store.status}
                      </span>
                    </div>

                    {/* Store Header */}
                    <div className="flex items-start gap-4 mb-4">
                      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 text-xl font-bold text-primary transition-transform group-hover:scale-110">
                        {store.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0 pt-1">
                        <h3 className="font-semibold text-foreground truncate group-hover:text-primary transition-colors">
                          {store.name}
                        </h3>
                        <p className="text-sm text-muted-foreground truncate">
                          {store.domain || `${store.slug}.forcemediakw.com`}
                        </p>
                      </div>
                    </div>

                    {/* Owner Info */}
                    <div className="flex items-center gap-2 mb-4 pb-4 border-b border-border/50">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-xs font-medium text-muted-foreground">
                        {store.owner.firstName?.[0]}{store.owner.lastName?.[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {store.owner.firstName} {store.owner.lastName}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">{store.owner.email}</p>
                      </div>
                    </div>

                    {/* Stats */}
                    <div className="grid grid-cols-3 gap-4 mb-4">
                      <div className="text-center">
                        <p className="text-lg font-bold text-foreground">{store._count?.products || 0}</p>
                        <p className="text-xs text-muted-foreground">Products</p>
                      </div>
                      <div className="text-center border-x border-border/50">
                        <p className="text-lg font-bold text-foreground">{store._count?.orders || 0}</p>
                        <p className="text-xs text-muted-foreground">Orders</p>
                      </div>
                      <div className="text-center">
                        <p className="text-lg font-bold text-foreground">
                          <span className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs ${plan.bg} ${plan.text}`}>
                            <span>{plan.icon}</span>
                            <span className="capitalize">{store.plan}</span>
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground">Plan</p>
                      </div>
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-between pt-4 border-t border-border/50">
                      <span className="text-xs text-muted-foreground">
                        Created {formatDate(store.createdAt)}
                      </span>
                      <span className="text-xs font-medium text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                        View Details →
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}

          {/* Table View */}
          {viewMode === 'table' && (
            <div className="force-card p-0 overflow-hidden">
              <table className="w-full">
                <thead className="bg-muted/50 border-b">
                  <tr>
                    <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Store</th>
                    <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Owner</th>
                    <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Status</th>
                    <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Plan</th>
                    <th className="px-6 py-4 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider">Products</th>
                    <th className="px-6 py-4 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider">Orders</th>
                    <th className="px-6 py-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Created</th>
                    <th className="px-6 py-4 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {stores.map((store) => {
                    const status = statusConfig[store.status];
                    const plan = planConfig[store.plan];
                    return (
                      <tr key={store.id} className="hover:bg-muted/30 transition-colors">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 font-bold text-primary">
                              {store.name.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <p className="font-medium text-foreground">{store.name}</p>
                              <p className="text-sm text-muted-foreground">{store.domain || `${store.slug}.forcemediakw.com`}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div>
                            <p className="text-sm font-medium text-foreground">{store.owner.firstName} {store.owner.lastName}</p>
                            <p className="text-sm text-muted-foreground">{store.owner.email}</p>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${status.bg} ${status.text}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                            {store.status}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium ${plan.bg} ${plan.text}`}>
                            <span>{plan.icon}</span>
                            <span className="capitalize">{store.plan}</span>
                          </span>
                        </td>
                        <td className="px-6 py-4 text-center">
                          <span className="font-semibold text-foreground">{store._count?.products || 0}</span>
                        </td>
                        <td className="px-6 py-4 text-center">
                          <span className="font-semibold text-foreground">{store._count?.orders || 0}</span>
                        </td>
                        <td className="px-6 py-4 text-sm text-muted-foreground">
                          {formatDate(store.createdAt)}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <Link href={`/stores/${store.id}`}>
                            <Button variant="outline" size="sm" className="rounded-xl">
                              View
                            </Button>
                          </Link>
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
            <div className="mt-6 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Showing <span className="font-medium text-foreground">{((pagination.page - 1) * pagination.limit) + 1}</span> to{' '}
                <span className="font-medium text-foreground">{Math.min(pagination.page * pagination.limit, pagination.total)}</span> of{' '}
                <span className="font-medium text-foreground">{pagination.total}</span> stores
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
        </>
      ) : !error ? (
        /* Empty State */
        <div className="force-card py-16">
          <div className="flex flex-col items-center text-center">
            <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-primary/20 to-primary/5">
              <svg className="h-10 w-10 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-foreground mb-2">No stores found</h3>
            <p className="text-muted-foreground mb-6 max-w-sm">
              {search || statusFilter !== 'all'
                ? 'Try adjusting your search or filter criteria'
                : 'Get started by creating your first store on the platform'}
            </p>
            <Link href="/stores/new">
              <Button className="gap-2 shadow-lg shadow-primary/25">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Create Your First Store
              </Button>
            </Link>
          </div>
        </div>
      ) : null}
    </AdminLayout>
  );
}
