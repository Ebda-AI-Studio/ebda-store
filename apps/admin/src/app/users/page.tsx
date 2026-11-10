'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge, Modal, ModalBody, ModalFooter, Input, Label } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { AdminLayout } from '../../components/AdminLayout';
import { ErrorState } from '../../components/ErrorState';
import { apiGet, apiPost } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useLatestRequest } from '../../hooks/useLatestRequest';
import { useT } from '@/i18n/useT';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { intlLocaleForUi } from '@/lib/format';

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
  const router = useRouter();
  const { user: currentUser } = useAuth();

  // Super-admin only. Store admins shouldn't reach this URL via the nav,
  // but if they manually browse here, bounce them back to root.
  useEffect(() => {
    if (currentUser && currentUser.role !== 'super_admin') {
      router.replace('/');
    }
  }, [currentUser, router]);

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
  // Bumped after an invite: the fetch effect owns EVERY list request, so the refetch reads the
  // CURRENT role filter/page/search, not the ones captured when the handler's render ran (issue 2443).
  const [refreshKey, setRefreshKey] = useState(0);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteForm, setInviteForm] = useState({
    email: '',
    firstName: '',
    lastName: '',
    password: '',
    role: 'store_admin' as 'super_admin' | 'store_admin',
  });

  function resetInviteForm() {
    setInviteForm({
      email: '',
      firstName: '',
      lastName: '',
      password: '',
      role: 'store_admin',
    });
    setInviteError(null);
  }

  function formatDate(date: string | null) {
    if (!date) return t('neverLoggedIn');
    return new Date(date).toLocaleDateString(intlLocaleForUi(), {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  // Latest-request-wins: a slower response for a previous filter/page must not repaint its rows.
  const beginRequest = useLatestRequest();
  const fetchUsers = useCallback(async () => {
    const isLatest = beginRequest();
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
      if (!isLatest()) return;
      if (data) {
        setUsers(data.users || []);
        setPagination(prev => ({ ...prev, ...data.pagination }));
      } else if (apiError) {
        setError(apiError.message || t('errorDefault'));
      }
    } catch (error) {
      if (isLatest()) {
        console.error('Failed to fetch users:', error);
        setError(t('errorNetwork'));
      }
    } finally {
      if (isLatest()) setIsLoading(false);
    }
  }, [pagination.page, pagination.limit, roleFilter, debouncedSearch, t, beginRequest]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers, refreshKey]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPagination(prev => ({ ...prev, page: 1 }));
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteError(null);
    setInviting(true);
    try {
      const { error: apiError } = await apiPost<{ user: User }>('/api/v1/admin/users', inviteForm);
      if (apiError) {
        setInviteError(apiError.message || t('errorDefault'));
        return;
      }
      setInviteOpen(false);
      resetInviteForm();
      setRefreshKey(k => k + 1);
    } catch {
      setInviteError(t('errorNetwork'));
    } finally {
      setInviting(false);
    }
  }

  const columns: DataTableColumn<User>[] = [
    {
      header: t('colUser'),
      primaryOnMobile: true,
      cell: user => (
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary-ink">
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
      ),
    },
    {
      header: t('colRole'),
      mobileBadge: true,
      cell: user => <Badge variant={roleColors[user.role]}>{t(`role.${user.role}`)}</Badge>,
    },
    {
      header: t('colStatus'),
      mobileBadge: true,
      cell: user => <Badge variant={statusColors[user.status]}>{t(`status.${user.status}`)}</Badge>,
    },
    {
      header: t('colStores'),
      cell: user => (
        <span className="text-sm text-muted-foreground">
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
        </span>
      ),
    },
    {
      header: t('colJoined'),
      hideOnMobile: true,
      cell: user => (
        <span className="text-sm text-muted-foreground">{formatDate(user.createdAt)}</span>
      ),
    },
    {
      header: t('colLastLogin'),
      hideOnMobile: true,
      cell: user => (
        <span className="text-sm text-muted-foreground">{formatDate(user.lastLoginAt)}</span>
      ),
    },
    {
      header: t('colActions'),
      alignEnd: true,
      mobileActions: true,
      cell: user => (
        <Link href={`/users/${user.id}`}>
          <Button variant="outline" size="sm" className="max-md:min-h-11 max-md:px-4">
            {t('view')}
          </Button>
        </Link>
      ),
    },
  ];

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <Button size="sm" onClick={() => setInviteOpen(true)}>
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
            onChange={e => {
              setRoleFilter(e.target.value);
              // Reset to page 1 so the new filter always starts from the
              // first result — staying on page N with fewer results would
              // surface empty state and hide the pagination controls.
              setPagination(prev => ({ ...prev, page: 1 }));
            }}
            aria-label={t('filterRoleLabel')}
            className="rounded-lg border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="all">{t('allRoles')}</option>
            <option value="super_admin">{t('roleSuperAdmins')}</option>
            <option value="store_admin">{t('roleStoreAdmins')}</option>
            {/* customers are store-scoped; they appear in /customers not here */}
          </select>
        </div>
      </div>

      {/* Error State */}
      {error && !isLoading && (
        <ErrorState
          title={t('errorTitle')}
          message={error}
          onRetry={() => setRefreshKey(k => k + 1)}
        />
      )}

      {/* Users Table */}
      {!error && (
        <>
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="rounded-xl border border-border bg-card p-4 shadow-sm">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 bg-muted rounded-full animate-pulse" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 w-32 bg-muted rounded animate-pulse" />
                      <div className="h-3 w-40 bg-muted rounded animate-pulse" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <DataTable<User>
              ariaLabel={t('tableLabel')}
              columns={columns}
              rows={users}
              rowKey={user => user.id}
              emptyState={
                <div className="rounded-xl border bg-card shadow-sm px-6 py-12 text-center">
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
                </div>
              }
            />
          )}

          {/* Pagination */}
          {pagination.totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between rounded-xl border bg-card px-6 py-3 shadow-sm">
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
        </>
      )}
      <Modal
        isOpen={inviteOpen}
        onClose={() => {
          setInviteOpen(false);
          resetInviteForm();
        }}
        title={t('inviteUser')}
        size="md"
      >
        <form onSubmit={handleInvite}>
          <ModalBody className="space-y-4">
            <div>
              <Label htmlFor="invite-email">{t('email')}</Label>
              <Input
                id="invite-email"
                type="email"
                required
                autoComplete="off"
                value={inviteForm.email}
                onChange={e => setInviteForm({ ...inviteForm, email: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="invite-first">{t('firstName')}</Label>
                <Input
                  id="invite-first"
                  required
                  value={inviteForm.firstName}
                  onChange={e => setInviteForm({ ...inviteForm, firstName: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="invite-last">{t('lastName')}</Label>
                <Input
                  id="invite-last"
                  required
                  value={inviteForm.lastName}
                  onChange={e => setInviteForm({ ...inviteForm, lastName: e.target.value })}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="invite-password">{t('password')}</Label>
              <Input
                id="invite-password"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={inviteForm.password}
                onChange={e => setInviteForm({ ...inviteForm, password: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="invite-role">{t('roleLabel')}</Label>
              <select
                id="invite-role"
                className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={inviteForm.role}
                onChange={e =>
                  setInviteForm({
                    ...inviteForm,
                    role: e.target.value as 'super_admin' | 'store_admin',
                  })
                }
              >
                <option value="store_admin">{t('roleStoreAdmins')}</option>
                <option value="super_admin">{t('roleSuperAdmins')}</option>
              </select>
            </div>
            {inviteError && (
              <p className="text-sm text-destructive-ink" role="alert">
                {inviteError}
              </p>
            )}
          </ModalBody>
          <ModalFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setInviteOpen(false);
                resetInviteForm();
              }}
              disabled={inviting}
            >
              {tc('cancel')}
            </Button>
            <Button type="submit" disabled={inviting}>
              {inviting ? tc('saving') : t('inviteUser')}
            </Button>
          </ModalFooter>
        </form>
      </Modal>
    </AdminLayout>
  );
}
