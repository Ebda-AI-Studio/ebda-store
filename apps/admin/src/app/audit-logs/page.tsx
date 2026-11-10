'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { AdminLayout } from '../../components/AdminLayout';
import { apiGet } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useStore } from '../../contexts/StoreContext';
import { useT } from '@/i18n/useT';

interface AuditLog {
  id: string;
  action: string;
  entityType: 'store' | 'user' | 'product' | 'order' | 'setting';
  entityId: string;
  details: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
  createdAt: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  } | null;
  store?: {
    id: string;
    name: string;
  };
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

import { formatDateTime } from '@/lib/format';

const actionColors: Record<string, 'default' | 'secondary' | 'destructive'> = {
  create: 'default',
  update: 'secondary',
  delete: 'destructive',
  login: 'default',
  logout: 'secondary',
  suspend: 'destructive',
  activate: 'default',
};

const entityIcons: Record<string, string> = {
  store:
    'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4',
  user: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
  product: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  order:
    'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
  setting:
    'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
};

export default function AuditLogsPage() {
  const t = useT('audit');
  const router = useRouter();
  const { user: currentUser } = useAuth();

  // Audit logs are super-admin only. Bounce store admins back to root.
  useEffect(() => {
    if (currentUser && currentUser.role !== 'super_admin') {
      router.replace('/');
    }
  }, [currentUser, router]);

  const { selectedStoreId } = useStore();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [entityFilter, setEntityFilter] = useState<string>('all');
  const [actionFilter, setActionFilter] = useState<string>('all');
  const [expandedLog, setExpandedLog] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        limit: pagination.limit.toString(),
      });
      if (entityFilter !== 'all') params.append('entityType', entityFilter);
      if (actionFilter !== 'all') params.append('action', actionFilter);
      if (selectedStoreId !== 'all') params.append('storeId', selectedStoreId);

      const { data } = await apiGet<{
        logs: AuditLog[];
        meta: Pagination;
      }>(`/api/v1/admin/audit-logs?${params}`);
      if (data) {
        setLogs(data.logs || []);
        setPagination(prev => ({ ...prev, ...data.meta }));
      }
    } catch (error) {
      console.error('Failed to fetch audit logs:', error);
    } finally {
      setIsLoading(false);
    }
  }, [pagination.page, pagination.limit, entityFilter, actionFilter, selectedStoreId]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  function getActionColor(action: string): 'default' | 'secondary' | 'destructive' {
    const normalizedAction = action.toLowerCase();
    for (const [key, value] of Object.entries(actionColors)) {
      if (normalizedAction.includes(key)) return value;
    }
    return 'secondary';
  }

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <Button variant="outline" size="sm" onClick={() => fetchLogs()}>
          <svg className="me-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          {t('refresh')}
        </Button>
      }
    >
      {/* Filters */}
      <div className="mb-6 flex flex-wrap gap-4">
        <select
          value={entityFilter}
          onChange={e => setEntityFilter(e.target.value)}
          aria-label={t('filterEntityLabel')}
          className="rounded-lg border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="all">{t('allEntities')}</option>
          <option value="store">{t('entityStore')}</option>
          <option value="user">{t('entityUser')}</option>
          <option value="product">{t('entityProduct')}</option>
          <option value="order">{t('entityOrder')}</option>
          <option value="setting">{t('entitySetting')}</option>
        </select>

        <select
          value={actionFilter}
          onChange={e => setActionFilter(e.target.value)}
          aria-label={t('filterActionLabel')}
          className="rounded-lg border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="all">{t('allActions')}</option>
          <option value="create">{t('actionCreate')}</option>
          <option value="update">{t('actionUpdate')}</option>
          <option value="delete">{t('actionDelete')}</option>
          <option value="login">{t('actionLogin')}</option>
          <option value="logout">{t('actionLogout')}</option>
        </select>
      </div>

      {/* Logs List */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <div className="divide-y">
          {isLoading ? (
            Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="p-4 flex items-start gap-4">
                <div className="h-10 w-10 bg-muted rounded-lg animate-pulse" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-3/4 bg-muted rounded animate-pulse" />
                  <div className="h-3 w-1/2 bg-muted rounded animate-pulse" />
                </div>
                <div className="h-4 w-32 bg-muted rounded animate-pulse" />
              </div>
            ))
          ) : logs.length > 0 ? (
            logs.map(log => (
              <div key={log.id} className="p-4">
                <div className="flex items-start gap-4">
                  {/* Entity Icon */}
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                    <svg
                      className="h-5 w-5 text-muted-foreground"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d={entityIcons[log.entityType] || entityIcons.setting}
                      />
                    </svg>
                  </div>

                  {/* Log Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={getActionColor(log.action)}>{log.action}</Badge>
                      <span className="text-sm text-muted-foreground capitalize">
                        {log.entityType}
                      </span>
                      {log.store && (
                        <Link
                          href={`/stores/${log.store.id}`}
                          className="text-sm text-primary hover:underline"
                        >
                          {log.store.name}
                        </Link>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-foreground">
                      {log.user ? (
                        <Link
                          href={`/users/${log.user.id}`}
                          className="font-medium hover:text-primary"
                        >
                          {log.user.firstName} {log.user.lastName}
                        </Link>
                      ) : (
                        <span className="font-medium text-muted-foreground">{t('system')}</span>
                      )}{' '}
                      {log.action.toLowerCase()} {log.entityType}
                      {log.entityId && (
                        <span className="text-muted-foreground">
                          {' '}
                          ({t('idPrefix')} {log.entityId.slice(0, 8)}...)
                        </span>
                      )}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {log.ipAddress} | {log.userAgent?.slice(0, 50)}...
                    </p>

                    {/* Expandable Details */}
                    {Object.keys(log.details || {}).length > 0 && (
                      <Button
                        variant="link"
                        size="sm"
                        type="button"
                        onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id)}
                        className="mt-2"
                      >
                        {expandedLog === log.id ? t('hideDetails') : t('showDetails')}
                      </Button>
                    )}
                    {expandedLog === log.id && (
                      <pre className="mt-2 p-3 bg-muted rounded-lg text-xs text-foreground overflow-x-auto">
                        {JSON.stringify(log.details, null, 2)}
                      </pre>
                    )}
                  </div>

                  {/* Timestamp */}
                  <div className="text-end flex-shrink-0">
                    <p className="text-sm text-muted-foreground">{formatDateTime(log.createdAt)}</p>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="p-12 text-center">
              <svg
                className="mx-auto h-12 w-12 text-muted-foreground"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <p className="mt-4 text-muted-foreground">{t('empty')}</p>
            </div>
          )}
        </div>

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
                disabled={pagination.page === 1}
                onClick={() => setPagination(prev => ({ ...prev, page: prev.page - 1 }))}
              >
                {t('previous')}
              </Button>
              <Button
                variant="outline"
                disabled={pagination.page === pagination.totalPages}
                onClick={() => setPagination(prev => ({ ...prev, page: prev.page + 1 }))}
              >
                {t('next')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
