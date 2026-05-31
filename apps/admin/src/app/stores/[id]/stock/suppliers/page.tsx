'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { SearchInput } from '@/components/SearchInput';
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

interface SuppliersResponse {
  data: Supplier[];
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
    apiGet<SuppliersResponse>(`/api/v1/stores/${storeId}/suppliers`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else {
          setSuppliers(data?.data ?? []);
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

        {filteredSuppliers !== null && filteredSuppliers.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No suppliers yet. Add one with the button above.
          </p>
        ) : (
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr>
                  <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                    {t('name')}
                  </th>
                  <th className="text-start px-3 py-2 font-medium text-muted-foreground w-36">
                    {t('contact')}
                  </th>
                  <th className="text-start px-3 py-2 font-medium text-muted-foreground w-32">
                    {t('phone')}
                  </th>
                  <th className="text-start px-3 py-2 font-medium text-muted-foreground w-40">
                    {t('email')}
                  </th>
                  <th className="text-start px-3 py-2 font-medium text-muted-foreground w-32">
                    {t('paymentTerms')}
                  </th>
                  <th className="text-center px-3 py-2 font-medium text-muted-foreground w-20">
                    {t('active')}
                  </th>
                  <th className="px-3 py-2 w-28" />
                </tr>
              </thead>
              <tbody>
                {(filteredSuppliers ?? []).map(s => (
                  <tr key={s.id} className="border-t border-border/40">
                    <td className="px-3 py-2 font-medium truncate max-w-[12rem]">{s.name}</td>
                    <td className="px-3 py-2 text-muted-foreground truncate">
                      {s.contactName ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground font-mono text-xs">
                      {s.phone ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground truncate text-xs">
                      {s.email ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {s.paymentTerms === 'custom'
                        ? `${s.customTermsDays ?? '?'} days`
                        : t(`terms.${s.paymentTerms}`)}
                    </td>
                    <td className="px-3 py-2 text-center text-muted-foreground">
                      {s.isActive ? '✓' : '—'}
                    </td>
                    <td className="px-3 py-2 text-end">
                      <div className="flex gap-2 justify-end">
                        <button
                          type="button"
                          onClick={() =>
                            router.push(`/stores/${storeId}/stock/suppliers/new?supplierId=${s.id}`)
                          }
                          className="text-primary text-xs underline underline-offset-2 hover:opacity-80"
                        >
                          Edit
                        </button>
                        {s.isActive && (
                          <button
                            type="button"
                            onClick={() => handleDeactivate(s.id)}
                            disabled={deleting === s.id}
                            className="text-red-600 text-xs underline underline-offset-2 hover:opacity-80 disabled:opacity-40"
                          >
                            Deactivate
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
