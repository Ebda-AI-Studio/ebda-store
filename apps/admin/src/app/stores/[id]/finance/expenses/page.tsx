'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import { AdminLayout } from '@/components/AdminLayout';
import { DateRangePicker } from '@/components/DateRangePicker';
import { useT } from '@/i18n/useT';
import { Button, useToast } from '@ebda/ui';
import { RowActions } from '@/components/RowActions';
import { useConfirm } from '@/hooks/useConfirm';
import { apiGetPage, apiPost, type PageMeta } from '@/lib/api';
import { minorToMajor } from '@/lib/format';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import type { Period, ResolvedDateRange } from '../../analytics/_components/types';
import { resolveDateRange } from '../../analytics/_components/types';
import { withNumerals } from '@ebda/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

const PER_PAGE = 50;

const EXPENSE_STATUSES = ['draft', 'pending', 'approved', 'posted', 'rejected'] as const;
type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

function isExpenseStatus(v: string | null): v is ExpenseStatus {
  return (EXPENSE_STATUSES as readonly string[]).includes(v ?? '');
}

interface ExpenseRow {
  id: string;
  expenseNumber: string;
  expenseDate: string;
  supplier: { name: string } | null;
  expenseAccount: { nameEn: string } | null;
  amount: number;
  taxAmount: number;
  totalAmount: number;
  status: ExpenseStatus;
  createdById: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const major = minorToMajor;

const STATUS_BADGE: Record<ExpenseStatus, string> = {
  draft: 'bg-muted text-foreground',
  pending: 'bg-warning/10 text-warning-ink',
  approved: 'bg-info/10 text-info-ink',
  posted: 'bg-success/10 text-success-ink',
  rejected: 'bg-destructive/10 text-destructive-ink',
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function ExpensesPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const t = useT('finance.expenses');
  const tc = useT('common');
  const askConfirm = useConfirm();
  const { error: toastError } = useToast();

  // `?status=draft&hasOcr=true` deep links (finance dashboard → "Pending receipt
  // drafts (any date)" → View all) land on the SAME slice the card counted: the
  // receipt-upload drafts over ALL dates, not this month's. The receipt filter
  // is visible (a chip with a way out) and, while on, replaces the date window.
  const searchParams = useSearchParams();
  const initialStatus = searchParams?.get('status') ?? null;
  const [statusFilter, setStatusFilter] = useState<ExpenseStatus | 'all'>(
    isExpenseStatus(initialStatus) ? initialStatus : 'all'
  );

  const [receiptOnly, setReceiptOnly] = useState(searchParams?.get('hasOcr') === 'true');

  const [period, setPeriod] = useState<Period>('this_month');
  const [customRange, setCustomRange] = useState<ResolvedDateRange | undefined>(undefined);

  const [expenses, setExpenses] = useState<ExpenseRow[] | null>(null);
  // `meta` from the route: without it a list capped at PER_PAGE rows says
  // nothing about the rows beyond it (issue 2417).
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  // Bumped after an action: the fetch effect owns EVERY request, so the refetch reads the CURRENT
  // filters/page instead of the ones captured when the row's button rendered (issue 2443).
  const [refreshKey, setRefreshKey] = useState(0);

  function toDateStr(d: Date): string {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  // Latest-request-wins: a slower response for the previous filter must not
  // repaint its rows under the new one.
  const beginRequest = useLatestRequest();
  const fetchExpenses = useCallback(() => {
    if (!storeId) return;
    const isLatest = beginRequest();
    const qs = new URLSearchParams({ perPage: String(PER_PAGE), page: String(page) });
    if (receiptOnly) {
      qs.set('hasOcr', 'true'); // any date, like the dashboard card
    } else {
      const resolved = resolveDateRange(period, customRange);
      // Calendar days: `expenseDate` is a date, not an instant (see the route).
      qs.set('from', toDateStr(resolved.startDate));
      qs.set('to', toDateStr(resolved.endDate));
    }
    if (statusFilter !== 'all') qs.set('status', statusFilter);
    setError(null);
    apiGetPage<ExpenseRow>(`/api/v1/stores/${storeId}/expenses?${qs}`)
      .then(({ data, meta: pageMeta, error: apiError }) => {
        if (!isLatest()) return;
        if (apiError) {
          setExpenses(null);
          setMeta(null);
          setError(apiError.message);
        } else {
          setExpenses(data ?? []);
          setMeta(pageMeta);
        }
      })
      .catch(() => {
        if (!isLatest()) return;
        setExpenses(null);
        setError(t('loadFailed'));
      });
  }, [storeId, period, customRange, statusFilter, receiptOnly, page, beginRequest]);

  useEffect(() => {
    fetchExpenses();
  }, [fetchExpenses, refreshKey]);

  async function performAction(expenseId: string, action: 'approve' | 'post' | 'reject') {
    if (action === 'reject') {
      const ok = await askConfirm({
        object: t('actions.rejectObject'),
        consequence: t('actions.rejectConsequence'),
        confirmLabel: t('actions.reject'),
      });
      if (!ok) return;
    }
    setActionLoading(expenseId + ':' + action);
    try {
      const { error: apiError } = await apiPost(
        `/api/v1/stores/${storeId}/expenses/${expenseId}/${action}`
      );
      if (apiError) {
        toastError(apiError.message);
      } else {
        setRefreshKey(k => k + 1);
      }
    } catch {
      toastError(t('actions.failed'));
    } finally {
      setActionLoading(null);
    }
  }

  const columns: DataTableColumn<ExpenseRow>[] = [
    {
      header: t('number'),
      primaryOnMobile: true,
      cell: exp => (
        <span className="font-mono text-xs text-muted-foreground">{exp.expenseNumber}</span>
      ),
    },
    {
      header: t('date'),
      cell: exp => <span className="whitespace-nowrap">{exp.expenseDate?.slice(0, 10)}</span>,
    },
    {
      header: t('vendor'),
      cell: exp => <span>{exp.supplier?.name ?? '—'}</span>,
    },
    {
      header: t('category'),
      cell: exp => <span>{exp.expenseAccount?.nameEn ?? '—'}</span>,
    },
    {
      header: t('amount'),
      hideOnMobile: true,
      alignEnd: true,
      cell: exp => <span className="font-mono">{major(exp.amount)}</span>,
    },
    {
      header: t('tax'),
      hideOnMobile: true,
      alignEnd: true,
      cell: exp => <span className="font-mono">{major(exp.taxAmount)}</span>,
    },
    {
      header: t('total'),
      alignEnd: true,
      cell: exp => <span className="font-mono font-medium">{major(exp.totalAmount)}</span>,
    },
    {
      header: t('status'),
      mobileBadge: true,
      cell: exp => (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[exp.status]}`}
        >
          {t(`statuses.${exp.status}`)}
        </span>
      ),
    },
    {
      header: '',
      mobileActions: true,
      cell: exp => {
        const isActing = actionLoading?.startsWith(exp.id + ':');
        return (
          <div className="flex items-center justify-end gap-1">
            {(exp.status === 'draft' || exp.status === 'pending') && (
              <Button
                size="sm"
                variant="outline"
                className="min-h-11 md:min-h-9"
                disabled={isActing}
                onClick={() => performAction(exp.id, 'approve')}
              >
                {t('actions.approve')}
              </Button>
            )}
            {exp.status === 'approved' && (
              <Button
                size="sm"
                variant="outline"
                className="min-h-11 md:min-h-9"
                disabled={isActing}
                onClick={() => performAction(exp.id, 'post')}
              >
                {t('actions.post')}
              </Button>
            )}
            {exp.status !== 'posted' && exp.status !== 'rejected' && (
              <RowActions
                menuLabel={t('actions.menu', { number: exp.expenseNumber })}
                items={[
                  {
                    label: t('actions.reject'),
                    destructive: true,
                    disabled: isActing,
                    onSelect: () => performAction(exp.id, 'reject'),
                  },
                ]}
              />
            )}
          </div>
        );
      },
    },
  ];

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('description')}
      actions={
        <Button
          className="min-h-11"
          onClick={() => router.push(`/stores/${storeId}/finance/expenses/new`)}
        >
          {t('newButton')}
        </Button>
      }
    >
      {receiptOnly ? (
        <div className="mb-3 flex w-fit items-center gap-2 rounded-lg border border-border bg-muted px-3 py-1.5 text-sm">
          <span>{t('receiptOnly')}</span>
          <button
            type="button"
            onClick={() => {
              setReceiptOnly(false);
              setPage(1); // a new filter is a new list, in the same batch (issue 2436)
            }}
            className="text-xs text-primary hover:underline"
          >
            {t('receiptOnlyClear')}
          </button>
        </div>
      ) : (
        <DateRangePicker
          period={period}
          custom={customRange}
          onChange={(p, c) => {
            setPeriod(p);
            if (c) setCustomRange(c);
            setPage(1); // a new filter is a new list, in the same batch (issue 2436)
          }}
        />
      )}

      <label className="mb-4 flex w-fit items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('status')}</span>
        <select
          value={statusFilter}
          onChange={e => {
            setStatusFilter(e.target.value as ExpenseStatus | 'all');
            setPage(1); // a new filter is a new list, in the same batch (issue 2436)
          }}
          className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
        >
          <option value="all">{t('allStatuses')}</option>
          {EXPENSE_STATUSES.map(s => (
            <option key={s} value={s}>
              {t(`statuses.${s}`)}
            </option>
          ))}
        </select>
      </label>

      {error && (
        <div className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive-ink">
          {error}
        </div>
      )}

      {!expenses && !error && (
        <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
      )}

      {expenses && (
        <div className="max-w-6xl">
          {expenses.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('emptyState')}</p>
          ) : (
            <>
              {meta && (
                <p className="mb-2 text-sm text-muted-foreground" data-testid="expenses-total">
                  {t('totalCount', { total: meta.total.toLocaleString(undefined, withNumerals()) })}
                </p>
              )}
              <DataTable<ExpenseRow>
                ariaLabel={t('title')}
                columns={columns}
                rows={expenses}
                rowKey={exp => exp.id}
              />
              {meta && meta.totalPages > 1 && (
                <div className="mt-4 flex items-center gap-2 text-sm">
                  <button
                    type="button"
                    disabled={meta.page <= 1}
                    onClick={() => setPage(meta.page - 1)}
                    aria-label={t('pager.previous')}
                    className="px-3 py-1 rounded border border-border disabled:opacity-40"
                  >
                    <span aria-hidden="true" className="inline-block rtl:rotate-180">
                      ←
                    </span>
                  </button>
                  <span className="text-muted-foreground">
                    {t('pager.pageOf', { page: meta.page, totalPages: meta.totalPages })}
                  </span>
                  <button
                    type="button"
                    disabled={meta.page >= meta.totalPages}
                    onClick={() => setPage(meta.page + 1)}
                    aria-label={t('pager.next')}
                    className="px-3 py-1 rounded border border-border disabled:opacity-40"
                  >
                    <span aria-hidden="true" className="inline-block rtl:rotate-180">
                      →
                    </span>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </AdminLayout>
  );
}
