'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { SearchInput } from '@/components/SearchInput';
import { DataTable } from '@/components/mobile/DataTable';
import { useT } from '@/i18n/useT';
import { apiGet, apiPatch } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { RowActions } from '@/components/RowActions';
import { PageState } from '@/components/PageState';
import { useConfirm } from '@/hooks/useConfirm';
import { EmptyState } from '@/components/EmptyState';

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
  const askConfirm = useConfirm();

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
      .catch(() => setError(t('loadFailed')));
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

  async function handleDeactivate(s: Supplier) {
    const ok = await askConfirm({
      object: t('deactivateObject', { name: s.name }),
      consequence: t('deactivateConsequence'),
      confirmLabel: t('deactivateAction'),
    });
    if (!ok) return;
    const id = s.id;
    setDeleting(id);
    await apiPatch(`/api/v1/stores/${storeId}/suppliers/${id}`, { isActive: false });
    setDeleting(null);
    load();
  }

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('description')}
      actions={
        <Button onClick={() => router.push(`/stores/${storeId}/stock/suppliers/new`)}>
          {t('newButton')}
        </Button>
      }
    >
      <div className="max-w-5xl space-y-4">
        <PageState
          loading={!suppliers && !error}
          error={error}
          onRetry={() => {
            setError(null);
            load();
          }}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <SearchInput
              value={search}
              onSearch={setSearch}
              placeholder={t('searchPlaceholder')}
              className="w-full sm:w-64"
            />
          </div>

          <DataTable<Supplier>
            ariaLabel={t('title')}
            columns={[
              {
                header: t('name'),
                primaryOnMobile: true,
                cell: s => (
                  <span className="font-medium truncate max-w-[12rem] block">{s.name}</span>
                ),
              },
              {
                header: t('contact'),
                className: 'w-36',
                cell: s => (
                  <span className="text-muted-foreground truncate block">
                    {s.contactName ?? '—'}
                  </span>
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
                  <RowActions
                    menuLabel={t('rowMenu', { name: s.name })}
                    items={[
                      {
                        label: tc('edit'),
                        href: `/stores/${storeId}/stock/suppliers/new?supplierId=${s.id}`,
                      },
                      ...(s.isActive
                        ? [
                            {
                              label: tc('deactivate'),
                              destructive: true,
                              disabled: deleting === s.id,
                              onSelect: () => handleDeactivate(s),
                            },
                          ]
                        : []),
                    ]}
                  />
                ),
              },
            ]}
            rows={filteredSuppliers ?? []}
            rowKey={s => s.id}
            emptyState={
              <EmptyState
                card
                icon="M3 7h18M5 7v12a1 1 0 001 1h12a1 1 0 001-1V7M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2"
                title={t('emptyState')}
                action={{
                  label: t('newButton'),
                  href: `/stores/${storeId}/stock/suppliers/new`,
                }}
              />
            }
          />
        </PageState>
      </div>
    </AdminLayout>
  );
}
