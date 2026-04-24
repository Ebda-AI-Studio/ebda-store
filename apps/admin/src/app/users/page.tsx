'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Button, Badge } from '@force/ui';
import { AdminLayout } from '../../components/AdminLayout';
import { ErrorState } from '../../components/ErrorState';
import { apiGet } from '../../lib/api';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useT } from '@/i18n/useT';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'store_admin' | 'customer';
  status: 'active' | 'inactive' | 'suspended';
  createdAt: string;
  lastLoginAt: string | null;
  stores?: { id: string; name: string }[];
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const roleColors = {
  super_admin: 'destructive',
  store_admin: 'default',
  customer: 'secondary',
} as const;

const statusColors = {
  active: 'default',
  inactive: 'secondary',
  suspended: 'destructive',
} as const;

export default function UsersPage() {
  const t = useT('users');
  const tc = useT('common');
  const [users, setUsers] = useState<User[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [roleFilter, setRoleFilter] = useState<string>('all');

  function formatDate(date: string | null) {
    if (!date) return t('neverLoggedIn');
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  const fetchUsers = useCallback(async () => {
    try {
      setError(null);
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        limit: pagination.limit.toString(),
      });
      if (roleFilter !== 'all') params.append('role', roleFilter);
      if (debouncedSearch) params.append('search', debouncedSearch);

      const { data, error: apiError } = await apiGet<{
        users: User[];
        pagination: Pagination;
      }>(`/api/v1/admin/users?${params}`);
      if (data) {
        setUsers(data.users || []);
        setPagination(prev => ({ ...prev, ...data.pagination }));
      } else if (apiError) {
        setError(apiError.message || t('errorDefault'));
      }
    } catch (error) {
      console.error('Failed to fetch users:', error);
      setError(t('errorNetwork'));
    } finally {
      setIsLoading(false);
    }
  }, [pagination.page, pagination.limit, roleFilter, debouncedSearch, t]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPagination(prev => ({ ...prev, page: 1 }));
  }

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <Button size="sm">
          <svg className="me-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {t('inviteUser')}
        </Button>
      }
    >
      {/* Filters */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <form onSubmit={handleSearch} className="flex flex-1 gap-2">
          <div className="relative flex-1 max-w-md">
            <svg
              className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
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
              placeholder={t('searchPlaceholder')}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full rounded-lg border py-2 ps-10 pe-4 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <Button type="submit" variant="outline" size="sm">
            {tc('search')}
          </Button>
        </form>

        <div className="flex gap-2">
          <select
            value={roleFilter}
            onChange={e => setRoleFilter(e.target.value)}
            aria-label={t('filterRoleLabel')}
            className="rounded-lg border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="all">{t('allRoles')}</option>
            <option value="super_admin">{t('roleSuperAdmins')}</option>
            <option value="store_admin">{t('roleStoreAdmins')}</option>
            <option value="customer">{t('roleCustomers')}</option>
          </select>
        </div>
      </div>

      {/* Error State */}
      {error && !isLoading && (
        <ErrorState title={t('errorTitle')} message={error} onRetry={fetchUsers} />
      )}

      {/* Users Table */}
      {!error && (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden overflow-x-auto">
          <table className="w-full" aria-label={t('tableLabel')}>
            <thead className="bg-muted border-b">
              <tr>
                <th
                  scope="col"
                  className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('colUser')}
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('colRole')}
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('colStatus')}
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('colStores')}
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('colJoined')}
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('colLastLogin')}
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-end text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('colActions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 bg-muted rounded-full animate-pulse" />
                        <div>
                          <div className="h-4 w-32 bg-muted rounded animate-pulse" />
                          <div className="h-3 w-40 bg-muted rounded animate-pulse mt-1" />
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="h-6 w-20 bg-muted rounded animate-pulse" />
                    </td>
                    <td className="px-6 py-4">
                      <div className="h-6 w-16 bg-muted rounded animate-pulse" />
                    </td>
                    <td className="px-6 py-4">
                      <div className="h-4 w-24 bg-muted rounded animate-pulse" />
                    </td>
                    <td className="px-6 py-4">
                      <div className="h-4 w-24 bg-muted rounded animate-pulse" />
                    </td>
                    <td className="px-6 py-4">
                      <div className="h-4 w-24 bg-muted rounded animate-pulse" />
                    </td>
                    <td className="px-6 py-4">
                      <div className="h-8 w-16 bg-muted rounded animate-pulse ms-auto" />
                    </td>
                  </tr>
                ))
              ) : users.length > 0 ? (
                users.map(user => (
                  <tr key={user.id} className="hover:bg-muted">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                          <span className="text-sm font-bold">
                            {user.firstName[0]}
                            {user.lastName[0]}
                          </span>
                        </div>
                        <div>
                          <p className="font-medium text-foreground">
                            {user.firstName} {user.lastName}
                          </p>
                          <p className="text-sm text-muted-foreground">{user.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <Badge variant={roleColors[user.role]}>{t(`role.${user.role}`)}</Badge>
                    </td>
                    <td className="px-6 py-4">
                      <Badge variant={statusColors[user.status]}>
                        {t(`status.${user.status}`)}
                      </Badge>
                    </td>
                    <td className="px-6 py-4 text-sm text-muted-foreground">
                      {user.stores && user.stores.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {user.stores.slice(0, 2).map(store => (
                            <Link
                              key={store.id}
                              href={`/stores/${store.id}`}
                              className="text-primary hover:underline"
                            >
                              {store.name}
                            </Link>
                          ))}
                          {user.stores.length > 2 && (
                            <span className="text-muted-foreground">
                              {t('moreCount', { count: user.stores.length - 2 })}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-sm text-muted-foreground">
                      {formatDate(user.createdAt)}
                    </td>
                    <td className="px-6 py-4 text-sm text-muted-foreground">
                      {formatDate(user.lastLoginAt)}
                    </td>
                    <td className="px-6 py-4 text-end">
                      <Link href={`/users/${user.id}`}>
                        <Button variant="outline" size="sm">
                          {t('view')}
                        </Button>
                      </Link>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center">
                    <div className="flex flex-col items-center">
                      <svg
                        className="h-12 w-12 text-muted-foreground"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1}
                          d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
                        />
                      </svg>
                      <p className="mt-4 text-muted-foreground">{t('empty')}</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Pagination */}
          {pagination.totalPages > 1 && (
            <div className="flex items-center justify-between border-t px-6 py-3">
              <p className="text-sm text-muted-foreground">
                {t('paginationShowing', {
                  from: (pagination.page - 1) * pagination.limit + 1,
                  to: Math.min(pagination.page * pagination.limit, pagination.total),
                  total: pagination.total,
                })}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pagination.page === 1}
                  onClick={() => setPagination(prev => ({ ...prev, page: prev.page - 1 }))}
                >
                  {t('previous')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pagination.page === pagination.totalPages}
                  onClick={() => setPagination(prev => ({ ...prev, page: prev.page + 1 }))}
                >
                  {t('next')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </AdminLayout>
  );
}
