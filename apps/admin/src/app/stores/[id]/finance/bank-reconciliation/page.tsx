'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGetPage, apiDelete, type PageMeta } from '@/lib/api';
import { PageControls } from '@/components/PageControls';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import { withNumerals } from '@ebda/shared';
import { uiIntlTag } from '@/lib/format';

// ─── Types ────────────────────────────────────────────────────────────────────

type StatementStatus = 'pending' | 'reconciling' | 'reconciled';

interface BankStatementRow {
  id: string;
  fileName: string;
  importedAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  status: StatementStatus;
  glAccount: { code: string; nameEn: string; nameAr: string | null };
  _count: { transactions: number };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(uiIntlTag('en-GB'));
}

const STATUS_CLASS: Record<StatementStatus, string> = {
  pending: 'bg-amber-100 text-amber-700',
  reconciling: 'bg-blue-100 text-blue-700',
  reconciled: 'bg-green-100 text-green-700',
};

const PER_PAGE = 50;

// ─── Component ────────────────────────────────────────────────────────────────

export default function BankReconciliationPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('finance.bankRec');

  const [statements, setStatements] = useState<BankStatementRow[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // Bumped after a delete: the fetch effect owns EVERY request, so the refetch reads the CURRENT
  // page instead of the one captured when the Delete button rendered (issue 2443).
  const [refreshKey, setRefreshKey] = useState(0);

  // Latest-request-wins: paging quickly (or a refetch after a delete) must not let an older
  // response repaint its rows over the newer page (issue 2436).
  const beginRequest = useLatestRequest();

  const fetchStatements = useCallback(async () => {
    if (!storeId) return;
    const isLatest = beginRequest();
    // GET /finance/bank-statements returns `{ data: items, meta }`. `apiGetPage` keeps the
    // sibling `meta` that `apiGet` drops, so the footer shows the store's REAL statement count
    // and a pager reaches every statement beyond the page (issue 2430).
    const {
      data,
      meta: pageMeta,
      error: err,
    } = await apiGetPage<BankStatementRow>(
      `/api/v1/stores/${storeId}/finance/bank-statements?perPage=${PER_PAGE}&page=${page}`
    );
    if (!isLatest()) return;
    if (err) {
      setError(err.message ?? 'Failed to load statements');
      return;
    }
    // Deleting the last statement of the last page leaves an empty page with no pager: step back.
    if (
      (data ?? []).length === 0 &&
      pageMeta &&
      pageMeta.totalPages > 0 &&
      page > pageMeta.totalPages
    ) {
      setPage(pageMeta.totalPages);
      return;
    }
    setError(null);
    setStatements(data ?? []);
    setMeta(pageMeta);
  }, [storeId, page, beginRequest]);

  useEffect(() => {
    fetchStatements();
  }, [fetchStatements, refreshKey]);

  async function handleDelete(id: string, fileName: string) {
    if (!confirm(`Delete statement "${fileName}"? This will remove all matched transactions.`))
      return;
    setDeleting(id);
    const { error: err } = await apiDelete(
      `/api/v1/stores/${storeId}/finance/bank-statements/${id}`
    );
    setDeleting(null);
    if (err) {
      alert(err.message ?? 'Delete failed');
      return;
    }
    setRefreshKey(k => k + 1);
  }

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="space-y-6 p-4 md:p-6">
        {/* Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground">{t('title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
          </div>
          <Link
            href={`/stores/${storeId}/finance/bank-reconciliation/import`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
              />
            </svg>
            {t('importButton')}
          </Link>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Loading */}
        {statements === null && !error && (
          <div className="flex h-40 items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        )}

        {/* Empty */}
        {statements !== null && statements.length === 0 && (
          <div className="rounded-xl border border-dashed border-border bg-muted/50 py-16 text-center">
            <svg
              className="mx-auto mb-3 h-10 w-10 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            <p className="text-sm text-muted-foreground">{t('noStatements')}</p>
            <Link
              href={`/stores/${storeId}/finance/bank-reconciliation/import`}
              className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              {t('importButton')} →
            </Link>
          </div>
        )}

        {/* Table */}
        {statements !== null && statements.length > 0 && (
          /* Bank statements list — genuine accounting grid (columns are the
             point); kept as an isolated horizontal-scroll container per the
             B1 mobile-table exception rather than card-stacked. */
          <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
            <table className="min-w-[640px] w-full divide-y divide-border text-sm">
              <thead className="bg-muted/50">
                <tr>
                  {[
                    t('fileName'),
                    t('account'),
                    t('period'),
                    t('imported'),
                    t('transactions'),
                    t('status'),
                    t('actions'),
                  ].map(h => (
                    <th
                      key={h}
                      className="whitespace-nowrap px-4 py-3 text-start text-xs font-medium uppercase tracking-wide text-muted-foreground"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {statements.map(stmt => (
                  <tr key={stmt.id} className="hover:bg-muted/50">
                    <td className="px-4 py-3 font-medium text-foreground">{stmt.fileName}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <span className="font-mono text-xs text-muted-foreground">
                        {stmt.glAccount.code}
                      </span>{' '}
                      {stmt.glAccount.nameEn}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {fmt(stmt.periodStart)} – {fmt(stmt.periodEnd)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{fmt(stmt.importedAt)}</td>
                    <td className="px-4 py-3 text-center text-foreground">
                      {stmt._count.transactions}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_CLASS[stmt.status]}`}
                      >
                        {t(`statusLabels.${stmt.status}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/stores/${storeId}/finance/bank-reconciliation/${stmt.id}`}
                          className="rounded px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10"
                        >
                          {t('view')}
                        </Link>
                        <button
                          onClick={() => handleDelete(stmt.id, stmt.fileName)}
                          disabled={deleting === stmt.id}
                          className="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40"
                        >
                          {deleting === stmt.id ? '…' : t('delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div
              className="border-t border-border px-4 py-3 text-xs text-muted-foreground"
              data-testid="statements-total"
            >
              {t('totalCount', {
                total: (meta?.total ?? statements.length).toLocaleString(undefined, withNumerals()),
              })}
            </div>
          </div>
        )}
        <PageControls meta={meta} onPageChange={setPage} />
      </div>
    </AdminLayout>
  );
}
