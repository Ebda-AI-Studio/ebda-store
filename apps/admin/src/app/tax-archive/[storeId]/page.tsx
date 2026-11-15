'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { AdminLayout } from '../../../components/AdminLayout';
import { RequireSuperAdmin } from '../../../components/RequireSuperAdmin';
import { SearchInput } from '../../../components/SearchInput';
import { FiscalDocumentsTable } from '../../../components/fiscal/FiscalDocumentsTable';
import { apiGet } from '../../../lib/api';
import {
  FISCAL_DOC_TYPES,
  dayBound,
  formatFiscalDate,
  formatFiscalMoney,
  type ArchiveStoreSummary,
  type FiscalDocument,
} from '../../../lib/fiscal-documents';
import { useT } from '../../../i18n/useT';

const PAGE_SIZE = 25;

interface ListResponse {
  documents: FiscalDocument[];
  nextCursor: string | null;
}

/** One store's archived fiscal documents (super_admin only), deleted stores included. */
function StoreArchiveInner({ storeId }: { storeId: string }) {
  const t = useT('taxArchive');
  const ti = useT('invoices');
  const locale = useLocale();
  const [docType, setDocType] = useState('');
  const [search, setSearch] = useState('');
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [documents, setDocuments] = useState<FiscalDocument[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [summary, setSummary] = useState<ArchiveStoreSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (docType) qs.set('docType', docType);
      if (search.trim()) qs.set('q', search.trim());
      const from = dayBound(fromDay, false);
      const to = dayBound(toDay, true);
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      if (cursor) qs.set('cursor', cursor);
      return apiGet<ListResponse>(`/api/v1/admin/fiscal-archive/${storeId}?${qs}`);
    },
    [storeId, docType, search, fromDay, toDay]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    void fetchPage(null).then(({ data, error }) => {
      if (cancelled) return;
      setLoadError(!!error);
      setDocuments(data?.documents ?? []);
      setNextCursor(data?.nextCursor ?? null);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  useEffect(() => {
    let cancelled = false;
    void apiGet<{ summary: ArchiveStoreSummary | null }>(
      `/api/v1/admin/fiscal-archive/${storeId}?limit=1&summary=1`
    ).then(({ data }) => {
      if (!cancelled) setSummary(data?.summary ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    const { data, error } = await fetchPage(nextCursor);
    if (error) setLoadError(true);
    else {
      setDocuments(prev => [...prev, ...(data?.documents ?? [])]);
      setNextCursor(data?.nextCursor ?? null);
    }
    setLoadingMore(false);
  };

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <Link href="/tax-archive" className="text-sm text-primary hover:underline">
        {t('backToStores')}
      </Link>
      <p className="text-sm text-muted-foreground">{t('retention')}</p>

      {summary && (
        <dl
          className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3 text-sm sm:grid-cols-4"
          aria-label={t('summaryTitle')}
        >
          <div>
            <dt className="text-muted-foreground">{t('columns.documents')}</dt>
            <dd className="font-semibold">{summary.documentCount}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('columns.lastIssued')}</dt>
            <dd>
              {summary.lastIssuedAt ? formatFiscalDate(summary.lastIssuedAt, locale) : '—'}
              {summary.lastNumber && (
                <span dir="ltr" className="ms-1 font-mono text-xs">
                  {summary.lastNumber}
                </span>
              )}
            </dd>
          </div>
          <div dir="ltr" className="text-start">
            <dt className="text-muted-foreground" dir="auto">
              {t('periods.thisMonth')}
            </dt>
            <dd>
              {t('totals.net')} {formatFiscalMoney(summary.period.net, 'EGP')}
              <br />
              {t('totals.vat')} {formatFiscalMoney(summary.period.vat, 'EGP')}
              <br />
              <strong>
                {t('totals.gross')} {formatFiscalMoney(summary.period.gross, 'EGP')}
              </strong>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('columns.taxStatus')}</dt>
            <dd>
              {summary.trnPresent ? t('trn.present') : t('trn.missing')}
              <br />
              {summary.etaConnected
                ? summary.etaEnabled
                  ? t('eta.connected')
                  : t('eta.connectedOff')
                : t('eta.notConnected')}
            </dd>
          </div>
        </dl>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <SearchInput
          value={search}
          onSearch={setSearch}
          placeholder={t('searchPlaceholder')}
          ariaLabel={t('searchPlaceholder')}
          className="w-full sm:w-72"
        />
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{ti('filterLabel')}</span>
          <select
            value={docType}
            onChange={e => setDocType(e.target.value)}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          >
            <option value="">{ti('allTypes')}</option>
            {FISCAL_DOC_TYPES.map(k => (
              <option key={k} value={k}>
                {ti(`types.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('dateFrom')}</span>
          <input
            type="date"
            value={fromDay}
            max={toDay || undefined}
            onChange={e => setFromDay(e.target.value)}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('dateTo')}</span>
          <input
            type="date"
            value={toDay}
            min={fromDay || undefined}
            onChange={e => setToDay(e.target.value)}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
          />
        </label>
      </div>

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
          extended
          documents={documents}
          openHref={d => `/tax-archive/${storeId}/${d.id}`}
          emptyState={
            <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
              {t('emptyStore')}
            </div>
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
            {ti('loadMore')}
          </Button>
        </div>
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
