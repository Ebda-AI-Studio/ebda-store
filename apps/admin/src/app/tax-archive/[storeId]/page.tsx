'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AdminLayout } from '../../../components/AdminLayout';
import { RequireSuperAdmin } from '../../../components/RequireSuperAdmin';
import { FiscalDocumentsTable } from '../../../components/fiscal/FiscalDocumentsTable';
import { apiGet } from '../../../lib/api';
import type { FiscalDocument } from '../../../lib/fiscal-documents';
import { useT } from '../../../i18n/useT';

/** One store's archived fiscal documents (super_admin only), deleted stores included. */
function StoreArchiveInner({ storeId }: { storeId: string }) {
  const t = useT('taxArchive');
  const [documents, setDocuments] = useState<FiscalDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void apiGet<{ documents: FiscalDocument[] }>(`/api/v1/admin/fiscal-archive/${storeId}`).then(
      ({ data, error }) => {
        if (cancelled) return;
        setLoadError(!!error);
        setDocuments(data?.documents ?? []);
        setLoading(false);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <Link href="/tax-archive" className="text-sm text-primary hover:underline">
        {t('backToStores')}
      </Link>
      <p className="text-sm text-muted-foreground">{t('retention')}</p>
      {loadError && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-4 text-center text-sm text-destructive-ink"
        >
          {t('loadFailed')}
        </div>
      )}
      {loading ? (
        <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
          {t('loading')}
        </div>
      ) : (
        <FiscalDocumentsTable
          documents={documents}
          openHref={d => `/tax-archive/${storeId}/${d.id}`}
          emptyState={
            <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
              {t('emptyStore')}
            </div>
          }
        />
      )}
    </div>
  );
}

export default function TaxArchiveStorePage() {
  const params = useParams();
  const storeId = params?.storeId as string;
  const t = useT('taxArchive');
  return (
    <AdminLayout title={t('storeTitle')} mode="super_admin">
      <RequireSuperAdmin>
        <StoreArchiveInner storeId={storeId} />
      </RequireSuperAdmin>
    </AdminLayout>
  );
}
