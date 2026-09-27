'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet, apiDelete } from '@/lib/api';

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
  return new Date(iso).toLocaleDateString('en-GB');
}

const STATUS_CLASS: Record<StatementStatus, string> = {
  pending: 'bg-amber-100 text-amber-700',
  reconciling: 'bg-blue-100 text-blue-700',
  reconciled: 'bg-green-100 text-green-700',
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function BankReconciliationPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('finance.bankRec');

  const [statements, setStatements] = useState<BankStatementRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const fetchStatements = useCallback(async () => {
    if (!storeId) return;
    // GET /finance/bank-statements returns `{ data: items, meta }` — apiGet
    // unwraps one layer AND drops the sibling `meta`, so `data` IS the
    // statement array; reading `data?.data` double-unwrapped to undefined
    // and this page always rendered empty (#831 sweep). `meta.total` is not
    // recoverable through apiGet (it drops the sibling), so the footer count
    // falls back to the fetched-page length — correct as long as a store has
    // ≤50 statements (the requested perPage); beyond that it undercounts.
    // A true fix needs a raw-response variant of apiGet that preserves `meta`.
    const { data, error: err } = await apiGet<BankStatementRow[]>(
      `/api/v1/stores/${storeId}/finance/bank-statements?perPage=50`
    );
    if (err) {
      setError(err.message ?? 'Failed to load statements');
      return;
    }
    setStatements(data ?? []);
    setTotal(data?.length ?? 0);
  }, [storeId]);

  useEffect(() => {
    fetchStatements();
  }, [fetchStatements]);

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
    fetchStatements();
  }

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="space-y-6 p-4 md:p-6">
        {/* Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">{t('title')}</h1>
            <p className="mt-1 text-sm text-gray-500">{t('description')}</p>
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
          <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 py-16 text-center">
            <svg
              className="mx-auto mb-3 h-10 w-10 text-gray-300"
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
            <p className="text-sm text-gray-500">{t('noStatements')}</p>
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
          <div className="overflow-x-auto rounded-xl border border-gray-100 bg-white shadow-sm">
            <table className="min-w-[640px] w-full divide-y divide-gray-100 text-sm">
              <thead className="bg-gray-50">
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
                      className="whitespace-nowrap px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {statements.map(stmt => (
                  <tr key={stmt.id} className="hover:bg-gray-50/60">
                    <td className="px-4 py-3 font-medium text-gray-800">{stmt.fileName}</td>
                    <td className="px-4 py-3 text-gray-600">
                      <span className="font-mono text-xs text-gray-400">{stmt.glAccount.code}</span>{' '}
                      {stmt.glAccount.nameEn}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {fmt(stmt.periodStart)} – {fmt(stmt.periodEnd)}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{fmt(stmt.importedAt)}</td>
                    <td className="px-4 py-3 text-center text-gray-800">
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
            <div className="border-t border-gray-100 px-4 py-3 text-xs text-gray-400">
              {total} statement{total !== 1 ? 's' : ''}
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
