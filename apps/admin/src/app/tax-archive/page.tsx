'use client';

/**
 * Super-admin tax archive — /tax-archive (ruling MONEYB-4).
 *
 * Fiscal documents are kept for seven years, including those of stores that were later deleted.
 * This page lists every store that has archived documents; opening one shows its documents.
 *
 * Route guard: super_admin only (RequireSuperAdmin + the API's authorize('super_admin')).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale } from 'next-intl';
import { Badge } from '@ebda/ui';
import { AdminLayout } from '../../components/AdminLayout';
import { RequireSuperAdmin } from '../../components/RequireSuperAdmin';
import { DataTable, type DataTableColumn } from '../../components/mobile/DataTable';
import { apiGet } from '../../lib/api';
import { formatFiscalDate } from '../../lib/fiscal-documents';
import { useT } from '../../i18n/useT';

interface ArchiveStore {
  storeId: string;
  storeName: string | null;
  documentCount: number;
  lastIssuedAt: string | null;
  storeExists: boolean;
}

function TaxArchiveInner() {
  const t = useT('taxArchive');
  const locale = useLocale();
  const [stores, setStores] = useState<ArchiveStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void apiGet<{ stores: ArchiveStore[] }>('/api/v1/admin/fiscal-archive').then(
      ({ data, error }) => {
        if (cancelled) return;
        setLoadError(!!error);
        setStores(data?.stores ?? []);
        setLoading(false);
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const columns: DataTableColumn<ArchiveStore>[] = [
    {
      header: t('columns.store'),
      primaryOnMobile: true,
      cell: s => (
        <span className="font-medium text-foreground">
          {s.storeName ?? s.storeId}
          {!s.storeExists && (
            <Badge variant="destructive" className="ms-2">
              {t('deletedStore')}
            </Badge>
          )}
        </span>
      ),
    },
    {
      header: t('columns.documents'),
      cell: s => <span>{s.documentCount}</span>,
    },
    {
      header: t('columns.lastIssued'),
      hideOnMobile: true,
      cell: s => (
        <span className="text-muted-foreground">
          {s.lastIssuedAt ? formatFiscalDate(s.lastIssuedAt, locale) : '—'}
        </span>
      ),
    },
    {
      header: t('columns.actions'),
      cell: s => (
        <Link
          href={`/tax-archive/${s.storeId}`}
          className="inline-flex rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
        >
          {t('viewDocuments')}
        </Link>
      ),
    },
  ];

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <p className="text-sm text-muted-foreground">{t('retention')}</p>
      {loading ? (
        <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
          {t('loading')}
        </div>
      ) : (
        <DataTable<ArchiveStore>
          ariaLabel={t('title')}
          columns={columns}
          rows={stores}
          rowKey={s => s.storeId}
          emptyState={
            loadError ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-6 text-center text-destructive-ink"
              >
                {t('loadFailed')}
              </div>
            ) : (
              <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
                {t('empty')}
              </div>
            )
          }
        />
      )}
    </div>
  );
}

export default function TaxArchivePage() {
  const t = useT('taxArchive');
  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="super_admin">
      <RequireSuperAdmin>
        <TaxArchiveInner />
      </RequireSuperAdmin>
    </AdminLayout>
  );
}
