'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { AdminLayout } from '../../components/AdminLayout';
import { ErrorState } from '../../components/ErrorState';
import { apiGet } from '../../lib/api';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useAuth } from '../../lib/auth';
import { useT } from '@/i18n/useT';
import { useDeleteStore } from './_components/useDeleteStore';
import { StoresFilters } from './_components/StoresFilters';
import { StoresGrid } from './_components/StoresGrid';
import { StoresTable } from './_components/StoresTable';
import { StoresSkeleton } from './_components/StoresSkeleton';
import { StoresEmpty } from './_components/StoresEmpty';
import { StoresPagination } from './_components/StoresPagination';
import type { Pagination, Store } from './_components/types';

export default function StoresPage() {
  const t = useT('stores.list');
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const [stores, setStores] = useState<Store[]>([]);
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
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');

  const fetchStores = useCallback(async () => {
    try {
      setError(null);
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        limit: pagination.limit.toString(),
      });
      if (statusFilter !== 'all') params.append('status', statusFilter);
      if (debouncedSearch) params.append('search', debouncedSearch);

      const { data, error: apiError } = await apiGet<{
        stores: Store[];
        pagination: Pagination;
      }>(`/api/v1/admin/stores?${params}`);

      if (apiError) {
        setError(apiError.message || t('errorDefault'));
      } else if (data) {
        setStores(data.stores || []);
        setPagination(prev => ({ ...prev, ...data.pagination }));
      }
    } catch (error) {
      console.error('Failed to fetch stores:', error);
      setError(t('errorNetwork'));
    } finally {
      setIsLoading(false);
    }
  }, [pagination.page, pagination.limit, statusFilter, debouncedSearch, t]);

  useEffect(() => {
    fetchStores();
  }, [fetchStores]);

  const { requestDelete, dialog: deleteDialog } = useDeleteStore(
    useCallback(deleted => {
      setStores(prev => prev.filter(s => s.id !== deleted.id));
      setPagination(prev => ({ ...prev, total: Math.max(0, prev.total - 1) }));
    }, [])
  );
  const onDelete = isSuperAdmin ? requestDelete : undefined;

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPagination(prev => ({ ...prev, page: 1 }));
  }

  return (
    <AdminLayout
      title={t('title')}
      subtitle={
        statusFilter === 'all'
          ? t('subtitleCount', { count: pagination.total })
          : t('subtitleFiltered', { count: pagination.total, status: t(`status.${statusFilter}`) })
      }
      actions={
        <Link href="/stores/new">
          <Button size="sm" className="gap-2 shadow-md shadow-sm">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            {t('createStore')}
          </Button>
        </Link>
      }
    >
      <StoresFilters
        search={search}
        setSearch={setSearch}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        viewMode={viewMode}
        setViewMode={setViewMode}
        onSearchSubmit={handleSearch}
      />

      {/* Error State */}
      {error && !isLoading && (
        <ErrorState title={t('errorTitle')} message={error} onRetry={fetchStores} />
      )}

      {/* Loading State */}
      {!error && isLoading ? (
        <StoresSkeleton viewMode={viewMode} />
      ) : !error && stores.length > 0 ? (
        <>
          {viewMode === 'grid' ? (
            <StoresGrid stores={stores} onDelete={onDelete} />
          ) : (
            <StoresTable stores={stores} onDelete={onDelete} />
          )}
          <StoresPagination
            pagination={pagination}
            onPageChange={page => setPagination(prev => ({ ...prev, page }))}
          />
        </>
      ) : !error ? (
        <StoresEmpty search={search} statusFilter={statusFilter} />
      ) : null}
      {isSuperAdmin && deleteDialog}
    </AdminLayout>
  );
}
