'use client';

import { useCallback, useEffect, useState } from 'react';
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
  // A deleted store is served from the platform archive in keyset pages (`nextCursor`); a live store returns everything at once.
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null, isCancelled: () => boolean) => {
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const { data, error } = await apiGet<{
        documents: FiscalDocument[];
        nextCursor?: string | null;
      }>(`/api/v1/admin/fiscal-archive/${storeId}${qs}`);
      if (isCancelled()) return;
      setLoadError(!!error);
      setDocuments(prev => [...(cursor ? prev : []), ...(data?.documents ?? [])]);
      setNextCursor(data?.nextCursor ?? null);
      setLoading(false);
    },
    [storeId]
  );

  useEffect(() => {
    let cancelled = false;
    void load(null, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

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
      {nextCursor && (
        <button
          type="button"
          className="text-sm text-primary hover:underline"
          onClick={() => void load(nextCursor, () => false)}
        >
          {t('loadMore')}
        </button>
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
