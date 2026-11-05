'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { ErrorState } from '@/components/ErrorState';
// Contract shared with apps/api/src/routes/search-insights.routes.ts.
import type {
  SearchInsightsFilter,
  SearchInsightsResponse,
  SearchInsightsTerm,
} from '@ebda/shared';

const RANGES = [7, 30, 90] as const;

// Unknown (null) renders as "—", never as a fabricated 0%. Latin digits (NUMERALS-1):
// plain number formatting, never an Arabic-locale Intl.
function percent(rate: number | null | undefined): string {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

const pill = (active: boolean) =>
  `inline-flex min-h-11 items-center rounded-full border px-4 text-xs font-medium transition-colors ${
    active
      ? 'border-primary bg-primary text-primary-foreground'
      : 'border-border text-muted-foreground hover:text-foreground'
  }`;

export default function InsightsSearchesPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('insights.searches');

  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [filter, setFilter] = useState<SearchInsightsFilter>('zero');
  const [data, setData] = useState<SearchInsightsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!storeId) return;
    // A newer window/filter must never be overwritten by an older, slower response.
    let stale = false;
    setError(null);
    setLoading(true);
    apiGet<SearchInsightsResponse>(
      `/api/v1/stores/${storeId}/search-insights?days=${days}&filter=${filter}`
    )
      .then(({ data: d, error: apiError }) => {
        if (stale) return;
        if (apiError) setError(apiError.message ?? '');
        else if (d) setData(d);
      })
      .catch(() => {
        if (!stale) setError('');
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [storeId, days, filter, reloadKey]);

  if (error !== null) {
    return (
      <AdminLayout title={t('title')}>
        <ErrorState message={error || t('loadFailed')} onRetry={() => setReloadKey(k => k + 1)} />
      </AdminLayout>
    );
  }

  if (!data) {
    return (
      <AdminLayout title={t('title')}>
        <div className="flex items-center justify-center h-64">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </AdminLayout>
    );
  }

  const productsHref = (term: string) =>
    `/stores/${storeId}/products?q=${encodeURIComponent(term)}`;

  const columns: DataTableColumn<SearchInsightsTerm>[] = [
    {
      header: t('term'),
      primaryOnMobile: true,
      cell: row => (
        <Link
          href={productsHref(row.term)}
          dir="auto"
          aria-label={t('openTerm', { term: row.term })}
          className="inline-flex min-h-11 items-center font-medium text-foreground hover:underline"
        >
          {row.term}
        </Link>
      ),
    },
    {
      header: t('searches'),
      alignEnd: true,
      cell: row => <span className="font-mono tabular-nums">{row.searches}</span>,
    },
    {
      header: t('zeroResults'),
      alignEnd: true,
      cell: row => (
        <span
          className={`font-mono tabular-nums ${row.zeroResults > 0 ? 'text-warning-ink font-semibold' : 'text-muted-foreground'}`}
        >
          {row.zeroResults}
        </span>
      ),
    },
    {
      header: t('lastResults'),
      alignEnd: true,
      hideOnMobile: true,
      cell: row => (
        <span className="font-mono tabular-nums text-muted-foreground">{row.lastResultCount}</span>
      ),
    },
    {
      header: <span className="sr-only">{t('actions')}</span>,
      mobileActions: true,
      cell: row =>
        row.zeroResults > 0 ? (
          <Link
            href={productsHref(row.term)}
            className="inline-flex min-h-11 items-center text-xs font-medium text-primary"
          >
            {t('addTerm')}
          </Link>
        ) : null,
    },
  ];

  const nothingSearched = data.totals.searches === 0;

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="max-w-6xl space-y-6" aria-busy={loading}>
        {data.index && (
          // Task 12: the viewer of product_embeddings. Counts go in as strings so they stay Latin
          // digits in Arabic (NUMERALS-1).
          <p data-testid="search-index-status" className="text-sm text-muted-foreground">
            {!data.index.semanticEnabled && <span>{t('indexOff')} · </span>}
            <span className="tabular-nums">
              {t('indexStatus', {
                indexed: String(data.index.indexed),
                products: String(data.index.products),
              })}
            </span>
            {data.index.failed > 0 && (
              <span className="tabular-nums text-warning-ink">
                {' · '}
                {t('indexFailed', { failed: String(data.index.failed) })}
              </span>
            )}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div role="group" aria-label={t('range')} className="flex gap-2">
            {RANGES.map(r => (
              <button
                key={r}
                type="button"
                aria-pressed={days === r}
                className={pill(days === r)}
                onClick={() => setDays(r)}
              >
                {t(`days${r}` as 'days7' | 'days30' | 'days90')}
              </button>
            ))}
          </div>
          <div role="group" className="flex gap-2">
            <button
              type="button"
              aria-pressed={filter === 'zero'}
              className={pill(filter === 'zero')}
              onClick={() => setFilter('zero')}
            >
              {t('onlyZero')}
            </button>
            <button
              type="button"
              aria-pressed={filter === 'all'}
              className={pill(filter === 'all')}
              onClick={() => setFilter('all')}
            >
              {t('all')}
            </button>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-4 sm:max-w-md">
          <div className="rounded-lg border border-border bg-card p-4">
            <dt className="text-xs text-muted-foreground">{t('totalSearches')}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">{data.totals.searches}</dd>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <dt className="text-xs text-muted-foreground">{t('rate')}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">
              {percent(data.totals.zeroResultRate)}
            </dd>
          </div>
        </dl>

        <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          <DataTable<SearchInsightsTerm>
            ariaLabel={t('title')}
            columns={columns}
            rows={data.terms}
            rowKey={row => row.term}
            emptyState={
              <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
                {nothingSearched ? t('empty') : t('emptyZero')}
              </div>
            }
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('floorNote')}</p>
      </div>
    </AdminLayout>
  );
}
