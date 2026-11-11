'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { apiGet } from '../../../../../lib/api';
import { useRequireFeature } from '../../../../../hooks/useRequireFeature';
import { useLatestRequest } from '../../../../../hooks/useLatestRequest';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { useT } from '@/i18n/useT';
import { localDayRange, reportRangeParams, withNumerals } from '@ebda/shared';
import { intlLocaleForUi } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { SignedNumber } from '@ebda/ui';

interface LoyaltyTransaction {
  id: string;
  storeId: string;
  customerId: string;
  orderId: string | null;
  type: string;
  points: number;
  description: string | null;
  expiresAt: string | null;
  createdAt: string;
  customer: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
  };
  order: {
    id: string;
    orderNumber: string;
  } | null;
}

interface Meta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const TYPE_FILTERS = [
  'all',
  'earn_purchase',
  'earn_signup',
  'earn_referral',
  'earn_review',
  'earn_birthday',
  'earn_manual',
  'redeem_discount',
  'redeem_product',
  'expire',
  'adjust',
  'tier_changed',
] as const;

function TypeBadge({ type, label }: { type: string; label: string }) {
  let className = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ';
  if (type === 'tier_changed') {
    className += 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300';
  } else if (type.startsWith('earn_')) {
    className += 'bg-success/10 text-success-ink';
  } else if (type.startsWith('redeem_')) {
    className += 'bg-info/10 text-info-ink';
  } else if (type === 'expire') {
    className += 'bg-destructive/10 text-destructive-ink';
  } else {
    className += 'bg-muted text-muted-foreground';
  }
  return <span className={className}>{label}</span>;
}

function PointsCell({ points }: { points: number }) {
  if (points > 0)
    return (
      <span className="font-semibold text-emerald-600 dark:text-emerald-400">
        <SignedNumber value={points} plus />
      </span>
    );
  if (points < 0)
    return (
      <span className="font-semibold text-destructive-ink">
        <SignedNumber value={points} />
      </span>
    );
  return <span className="text-muted-foreground">0</span>;
}

export default function LoyaltyTransactionsPage() {
  const { gate } = useRequireFeature('loyalty');
  const t = useT('loyalty.transactions');

  const params = useParams();
  const storeId = params?.id as string;

  const [transactions, setTransactions] = useState<LoyaltyTransaction[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState('all');
  const [customerFilter, setCustomerFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Bumped by the customer-search submit: the fetch effect owns EVERY request, so the submit reads
  // the CURRENT page (just reset to 1) instead of a closure over the pre-reset page (issues 2443,
  // 2451).
  const [refreshKey, setRefreshKey] = useState(0);
  // Latest-request-wins: a slower response for a previous page/filter must not repaint its rows
  // (or its pager `meta`) under the new one.
  const beginRequest = useLatestRequest();
  const [loadFailed, setLoadFailed] = useState(false);

  const fetchTransactions = useCallback(async () => {
    const isLatest = beginRequest();
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set('page', String(page));
      qs.set('limit', '50');
      if (typeFilter !== 'all') qs.set('type', typeFilter);
      if (customerFilter.trim()) qs.set('customerId', customerFilter.trim());
      // The picked days in the viewer's timezone (shared report-range contract).
      const range = localDayRange(dateFrom, dateTo);
      if (range) for (const [k, v] of Object.entries(reportRangeParams(range))) qs.set(k, v);

      const { data, error: apiError } = await apiGet<{
        transactions: LoyaltyTransaction[];
        meta: Meta;
      }>(`/api/v1/stores/${storeId}/loyalty/transactions?${qs}`);
      if (!isLatest()) return;
      setLoadFailed(!!apiError);
      if (data) {
        setTransactions(data.transactions ?? []);
        setMeta(data.meta ?? null);
      }
    } catch {
      if (isLatest()) setLoadFailed(true);
    } finally {
      if (isLatest()) setLoading(false);
    }
  }, [storeId, page, typeFilter, customerFilter, dateFrom, dateTo, beginRequest]);

  useEffect(() => {
    fetchTransactions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, typeFilter, dateFrom, dateTo, refreshKey]);

  // Reset page when filters change
  const handleFilterChange = (setter: (v: string) => void, value: string) => {
    setPage(1);
    setter(value);
  };

  const handleCustomerSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setRefreshKey(k => k + 1);
  };

  const columns: DataTableColumn<LoyaltyTransaction>[] = [
    {
      header: t('colCustomer'),
      primaryOnMobile: true,
      cell: tx => (
        <div>
          <div className="text-sm font-medium text-foreground">
            {[tx.customer.firstName, tx.customer.lastName].filter(Boolean).join(' ') || '—'}
          </div>
          <div className="text-xs text-muted-foreground">{tx.customer.email ?? ''}</div>
        </div>
      ),
    },
    {
      header: t('colPoints'),
      mobileBadge: true,
      alignEnd: true,
      cell: tx => (
        <span className="font-mono text-sm">
          <PointsCell points={tx.points} />
        </span>
      ),
    },
    {
      header: t('colDate'),
      cell: tx => (
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {new Date(tx.createdAt).toLocaleDateString(intlLocaleForUi(), { dateStyle: 'medium' })}
        </span>
      ),
    },
    {
      header: t('colOrder'),
      cell: tx =>
        tx.order ? (
          <Link
            href={`/stores/${storeId}/orders/${tx.order.id}`}
            className="text-primary hover:underline font-mono text-xs"
          >
            {tx.order.orderNumber}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      header: t('colType'),
      cell: tx => (
        <TypeBadge
          type={tx.type}
          label={t(`typeLabels.${tx.type}` as Parameters<typeof t>[0]) ?? tx.type}
        />
      ),
    },
    {
      header: t('colDescription'),
      hideOnMobile: true,
      cell: tx => (
        <span className="text-sm text-muted-foreground max-w-xs truncate block">
          {tx.description ?? '—'}
        </span>
      ),
    },
    {
      header: t('colExpires'),
      hideOnMobile: true,
      cell: tx => (
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {tx.expiresAt
            ? new Date(tx.expiresAt).toLocaleDateString(intlLocaleForUi(), { dateStyle: 'medium' })
            : '—'}
        </span>
      ),
    },
  ];

  if (gate) return gate;

  return (
    <AdminLayout mode="store_admin" storeId={storeId} title={t('title')} subtitle={t('subtitle')}>
      <div className="mx-auto max-w-7xl px-4 pb-12 pt-4 sm:px-6">
        {/* Breadcrumb */}
        <nav className="mb-5 flex items-center gap-2 text-sm text-muted-foreground">
          <Link
            href={`/stores/${storeId}/loyalty`}
            className="hover:text-foreground transition-colors"
          >
            {t('breadcrumbLoyalty')}
          </Link>
          <span>/</span>
          <span className="text-foreground">{t('breadcrumbTransactions')}</span>
        </nav>

        {/* Filters */}
        <div className="mb-6 flex flex-wrap gap-3">
          {/* Type filter */}
          <select
            value={typeFilter}
            onChange={e => handleFilterChange(setTypeFilter, e.target.value)}
            aria-label={t('filterTypeAriaLabel')}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {TYPE_FILTERS.map(type => (
              <option key={type} value={type}>
                {t(`typeLabels.${type}` as Parameters<typeof t>[0]) ?? type}
              </option>
            ))}
          </select>

          {/* Date from */}
          <input
            type="date"
            value={dateFrom}
            onChange={e => handleFilterChange(setDateFrom, e.target.value)}
            aria-label={t('dateFromAriaLabel')}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />

          {/* Date to */}
          <input
            type="date"
            value={dateTo}
            onChange={e => handleFilterChange(setDateTo, e.target.value)}
            aria-label={t('dateToAriaLabel')}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />

          {/* Customer search */}
          <form onSubmit={handleCustomerSearch} className="flex gap-2">
            <input
              type="text"
              value={customerFilter}
              onChange={e => setCustomerFilter(e.target.value)}
              placeholder={t('customerIdPlaceholder')}
              aria-label={t('customerIdAriaLabel')}
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <Button variant="default" size="md" type="submit">
              {t('searchButton')}
            </Button>
          </form>
        </div>

        {/* A failed read is an error with a retry, never "no transactions". */}
        {loadFailed && !loading && (
          <div
            role="alert"
            className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive-ink"
          >
            {t('loadFailed')}
            <button
              type="button"
              className="ms-4 font-medium underline"
              onClick={fetchTransactions}
            >
              {t('retry')}
            </button>
          </div>
        )}

        {/* Table */}
        {loading ? (
          <div className="flex items-center justify-center py-16 rounded-2xl border border-border bg-card">
            <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
          </div>
        ) : (
          <DataTable
            ariaLabel={t('title')}
            columns={columns}
            rows={transactions}
            rowKey={tx => tx.id}
            emptyState={
              <div className="p-12 text-center">
                <p className="text-muted-foreground">{t('noTransactions')}</p>
              </div>
            }
          />
        )}

        {meta && meta.totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between rounded-xl border border-border bg-muted px-4 py-3">
            <p className="text-sm text-muted-foreground">
              {t('pageOf', {
                page: meta.page,
                totalPages: meta.totalPages,
                total: meta.total.toLocaleString(undefined, withNumerals()),
              })}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                type="button"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                {t('previous')}
              </Button>
              <Button
                variant="outline"
                type="button"
                onClick={() => setPage(p => Math.min(meta.totalPages, p + 1))}
                disabled={page >= meta.totalPages}
              >
                {t('next')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
