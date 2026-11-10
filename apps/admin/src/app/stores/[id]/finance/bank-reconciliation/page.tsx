'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGetPage, apiDelete, type PageMeta } from '@/lib/api';
import { PageControls } from '@/components/PageControls';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { ErrorState } from '@/components/ErrorState';
import { RowActions } from '@/components/RowActions';
import { useConfirm } from '@/hooks/useConfirm';
import { cn, useToast } from '@ebda/ui';
import { buttonVariants } from '@/components/ui/Button';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import { withNumerals } from '@ebda/shared';
import { intlLocaleForUi } from '@/lib/format';

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
  return new Date(iso).toLocaleDateString(intlLocaleForUi('en-GB'));
}

const STATUS_CLASS: Record<StatementStatus, string> = {
  pending: 'bg-warning/10 text-warning-ink',
  reconciling: 'bg-blue-100 text-blue-700',
  reconciled: 'bg-green-100 text-green-700',
};

const PER_PAGE = 50;

// ─── Component ────────────────────────────────────────────────────────────────

export default function BankReconciliationPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('finance.bankRec');
  const askConfirm = useConfirm();
  const { error: toastError } = useToast();

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
      setError(err.message ?? t('loadFailed'));
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
    const ok = await askConfirm({
      object: t('deleteObject', { name: fileName }),
      consequence: t('deleteConsequence'),
      confirmLabel: t('deleteAction'),
    });
    if (!ok) return;
    setDeleting(id);
    const { error: err } = await apiDelete(
      `/api/v1/stores/${storeId}/finance/bank-statements/${id}`
    );
    setDeleting(null);
    if (err) {
      toastError(err.message ?? t('deleteFailed'));
      return;
    }
    setRefreshKey(k => k + 1);
  }

  const columns: DataTableColumn<BankStatementRow>[] = [
    {
      header: t('fileName'),
      primaryOnMobile: true,
      cell: stmt => <span className="font-medium text-foreground">{stmt.fileName}</span>,
    },
    {
      header: t('account'),
      hideOnMobile: true,
      cell: stmt => (
        <span className="text-muted-foreground">
          <span className="font-mono text-xs">{stmt.glAccount.code}</span> {stmt.glAccount.nameEn}
        </span>
      ),
    },
    {
      header: t('period'),
      cell: stmt => (
        <span className="text-muted-foreground">
          {fmt(stmt.periodStart)} – {fmt(stmt.periodEnd)}
        </span>
      ),
    },
    {
      header: t('imported'),
      hideOnMobile: true,
      cell: stmt => <span className="text-muted-foreground">{fmt(stmt.importedAt)}</span>,
    },
    {
      header: t('transactions'),
      alignEnd: true,
      cell: stmt => <span className="text-foreground">{stmt._count.transactions}</span>,
    },
    {
      header: t('status'),
      mobileBadge: true,
      cell: stmt => (
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_CLASS[stmt.status]}`}
        >
          {t(`statusLabels.${stmt.status}`)}
        </span>
      ),
    },
    {
      header: '',
      alignEnd: true,
      mobileActions: true,
      cell: stmt => (
        <div className="flex items-center justify-end gap-1">
          <Link
            href={`/stores/${storeId}/finance/bank-reconciliation/${stmt.id}`}
            className="inline-flex min-h-11 items-center rounded px-3 text-xs font-medium text-primary-ink hover:bg-primary/10"
          >
            {t('view')}
          </Link>
          <RowActions
            menuLabel={t('rowMenu', { name: stmt.fileName })}
            items={[
              {
                label: deleting === stmt.id ? '…' : t('delete'),
                destructive: true,
                disabled: deleting === stmt.id,
                onSelect: () => handleDelete(stmt.id, stmt.fileName),
              },
            ]}
          />
        </div>
      ),
    },
  ];

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('description')}
      actions={
        <Link
          href={`/stores/${storeId}/finance/bank-reconciliation/import`}
          className={cn(buttonVariants(), 'min-h-11')}
        >
          {t('importButton')}
        </Link>
      }
    >
      <div className="space-y-6 p-4 md:p-6">
        {error && (
          <ErrorState
            message={error}
            onRetry={() => {
              setError(null);
              setRefreshKey(k => k + 1);
            }}
          />
        )}

        {statements === null && !error && (
          <div className="flex h-40 items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        )}

        {statements !== null && !error && (
          <div>
            <DataTable<BankStatementRow>
              ariaLabel={t('title')}
              columns={columns}
              rows={statements}
              rowKey={stmt => stmt.id}
              emptyState={
                <div className="py-10 text-center">
                  <p className="text-sm text-muted-foreground">{t('noStatements')}</p>
                  <Link
                    href={`/stores/${storeId}/finance/bank-reconciliation/import`}
                    className={cn(buttonVariants(), 'mt-4 min-h-11')}
                  >
                    {t('importButton')}
                  </Link>
                </div>
              }
            />
            {statements.length > 0 && (
              <div
                className="px-1 py-3 text-xs text-muted-foreground"
                data-testid="statements-total"
              >
                {t('totalCount', {
                  total: (meta?.total ?? statements.length).toLocaleString(
                    undefined,
                    withNumerals()
                  ),
                })}
              </div>
            )}
          </div>
        )}
        <PageControls meta={meta} onPageChange={setPage} />
      </div>
    </AdminLayout>
  );
}
