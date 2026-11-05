'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { useCurrentStore } from '@/hooks/useCurrentStore';
import { AdminLayout } from '../../../../components/AdminLayout';
import { SearchInput } from '../../../../components/SearchInput';
import { FiscalDocumentsTable } from '../../../../components/fiscal/FiscalDocumentsTable';
import { apiGet } from '../../../../lib/api';
import { FISCAL_DOC_TYPES, type FiscalDocument } from '../../../../lib/fiscal-documents';

const PAGE_SIZE = 25;

interface ListResponse {
  documents: FiscalDocument[];
  nextCursor: string | null;
}

/**
 * Invoices & credit notes: every fiscal document the store has issued (a tax invoice or sales
 * receipt per sale, a credit note or refund receipt per refund). Read-only: documents are
 * issued automatically and are immutable.
 */
export default function InvoicesPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('invoices');
  const { store } = useCurrentStore(storeId);

  const [docType, setDocType] = useState('');
  // Committed (already debounced by the shared SearchInput) document-number search.
  const [search, setSearch] = useState('');
  const [documents, setDocuments] = useState<FiscalDocument[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (docType) qs.set('docType', docType);
      if (search.trim()) qs.set('q', search.trim());
      if (cursor) qs.set('cursor', cursor);
      return apiGet<ListResponse>(`/api/v1/stores/${storeId}/fiscal-documents?${qs}`);
    },
    [storeId, docType, search]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    void fetchPage(null).then(({ data, error: err }) => {
      if (cancelled) return;
      setError(!!err);
      setDocuments(data?.documents ?? []);
      setNextCursor(data?.nextCursor ?? null);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    const { data, error: err } = await fetchPage(nextCursor);
    if (err) setError(true);
    else {
      setDocuments(prev => [...prev, ...(data?.documents ?? [])]);
      setNextCursor(data?.nextCursor ?? null);
    }
    setLoadingMore(false);
  };

  return (
    <AdminLayout mode="store_admin" storeId={storeId} title={t('title')} subtitle={t('subtitle')}>
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-4 sm:px-6">
        <SearchInput
          value={search}
          onSearch={setSearch}
          placeholder={t('searchPlaceholder')}
          ariaLabel={t('searchPlaceholder')}
          className="w-full sm:w-72"
        />
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('filterLabel')}</span>
          <select
            value={docType}
            onChange={e => setDocType(e.target.value)}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          >
            <option value="">{t('allTypes')}</option>
            {FISCAL_DOC_TYPES.map(k => (
              <option key={k} value={k}>
                {t(`types.${k}`)}
              </option>
            ))}
          </select>
        </label>

        {error && (
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
            timeZone={store?.timezone}
            orderHref={d => (d.orderId ? `/stores/${storeId}/orders/${d.orderId}` : null)}
            openHref={d => `/stores/${storeId}/invoices/${d.id}`}
            emptyState={
              error ? null : (
                <div className="rounded-lg border border-border px-4 py-8 text-center">
                  <p className="font-medium text-foreground">{t('emptyTitle')}</p>
                  <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                    {t('emptyDescription')}
                  </p>
                </div>
              )
            }
          />
        )}

        {nextCursor && !loading && (
          <div className="text-center">
            <Button
              variant="outline"
              onClick={loadMore}
              disabled={loadingMore}
              isLoading={loadingMore}
            >
              {t('loadMore')}
            </Button>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
