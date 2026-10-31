'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { SearchInput } from '@/components/SearchInput';
import { DataTable } from '@/components/mobile/DataTable';
import { useT } from '@/i18n/useT';
import { apiGet, apiPatch } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Supplier {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  paymentTerms: string;
  customTermsDays: number | null;
  isActive: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SuppliersPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const t = useT('stock.suppliers');
  const tc = useT('common');

  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // Debounced search term (SearchInput owns the debounce) — client-side filter
  // over fetched rows; supplier list is small enough that server-side paging
  // is unnecessary.
  const [search, setSearch] = useState('');

  function load() {
    if (!storeId) return;
    // apiGet already unwraps the API's `{ success, data }` envelope, so
    // `data` IS the supplier array — reading `data?.data` double-unwrapped
    // to undefined and the page always rendered empty (#831 sweep).
    apiGet<Supplier[]>(`/api/v1/stores/${storeId}/suppliers`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else {
          setSuppliers(data ?? []);
        }
      })
      .catch(() => setError('Failed to load suppliers'));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  // Client-side filter: match name, contact name, or email (case-insensitive).
  const filteredSuppliers = useMemo(() => {
    if (!suppliers) return suppliers;
    if (!search.trim()) return suppliers;
    const q = search.toLowerCase();
    return suppliers.filter(
      s =>
        s.name.toLowerCase().includes(q) ||
        (s.contactName ?? '').toLowerCase().includes(q) ||
        (s.email ?? '').toLowerCase().includes(q)
    );
  }, [suppliers, search]);

  async function handleDeactivate(id: string) {
    if (!confirm('Deactivate this supplier?')) return;
    setDeleting(id);
    await apiPatch(`/api/v1/stores/${storeId}/suppliers/${id}`, { isActive: false });
    setDeleting(null);
    load();
  }

  if (error) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-red-600 text-sm">{error}</div>
      </AdminLayout>
    );
  }

  if (!suppliers) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="max-w-5xl space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SearchInput
            value={search}
            onSearch={setSearch}
            placeholder={t('searchPlaceholder')}
            className="w-full sm:w-64"
          />
          <button
            type="button"
            onClick={() => router.push(`/stores/${storeId}/stock/suppliers/new`)}
            className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm"
          >
            {t('newButton')}
          </button>
        </div>

        <DataTable<Supplier>
          ariaLabel={t('title')}
          columns={[
            {
              header: t('name'),
              primaryOnMobile: true,
              cell: s => <span className="font-medium truncate max-w-[12rem] block">{s.name}</span>,
            },
            {
              header: t('contact'),
              className: 'w-36',
              cell: s => (
                <span className="text-muted-foreground truncate block">{s.contactName ?? '—'}</span>
              ),
            },
            {
              header: t('phone'),
              className: 'w-32',
              cell: s => (
                <span className="text-muted-foreground font-mono text-xs">{s.phone ?? '—'}</span>
              ),
            },
            {
              header: t('email'),
              hideOnMobile: true,
              className: 'w-40',
              cell: s => (
                <span className="text-muted-foreground truncate text-xs block">
                  {s.email ?? '—'}
                </span>
              ),
            },
            {
              header: t('paymentTerms'),
              className: 'w-32',
              cell: s => (
                <span className="text-muted-foreground">
                  {s.paymentTerms === 'custom'
                    ? t('termsDays', { count: s.customTermsDays ?? 0 })
                    : t(`terms.${s.paymentTerms}`)}
                </span>
              ),
            },
            {
              header: t('active'),
              mobileBadge: true,
              className: 'w-20 text-center',
              cell: s => <span className="text-muted-foreground">{s.isActive ? '✓' : '—'}</span>,
            },
            {
              header: '',
              alignEnd: true,
              mobileActions: true,
              className: 'w-28',
              cell: s => (
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    onClick={() =>
                      router.push(`/stores/${storeId}/stock/suppliers/new?supplierId=${s.id}`)
                    }
                    className="text-primary text-xs underline underline-offset-2 hover:opacity-80 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:px-2"
                  >
                    {tc('edit')}
                  </button>
                  {s.isActive && (
                    <button
                      type="button"
                      onClick={() => handleDeactivate(s.id)}
                      disabled={deleting === s.id}
                      className="text-red-600 text-xs underline underline-offset-2 hover:opacity-80 disabled:opacity-40 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:px-2"
                    >
                      {tc('deactivate')}
                    </button>
                  )}
                </div>
              ),
            },
          ]}
          rows={filteredSuppliers ?? []}
          rowKey={s => s.id}
          emptyState={<p className="text-muted-foreground text-sm">{t('emptyState')}</p>}
        />
      </div>
    </AdminLayout>
  );
}
