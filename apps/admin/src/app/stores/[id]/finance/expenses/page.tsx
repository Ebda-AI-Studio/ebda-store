'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useLatestRequest } from '@/hooks/useLatestRequest';
import { AdminLayout } from '@/components/AdminLayout';
import { DateRangePicker } from '@/components/DateRangePicker';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '@/lib/api';
import { filsToKwd } from '@/lib/format';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import type { Period, ResolvedDateRange } from '../../analytics/_components/types';
import { resolveDateRange } from '../../analytics/_components/types';

// ─── Types ────────────────────────────────────────────────────────────────────

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

const kwd = filsToKwd;

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

  // `?status=draft` deep links (finance dashboard → "Pending OCR drafts" →
  // View all) land filtered; the page used to ignore the query string.
  const searchParams = useSearchParams();
  const initialStatus = searchParams?.get('status') ?? null;
  const [statusFilter, setStatusFilter] = useState<ExpenseStatus | 'all'>(
    isExpenseStatus(initialStatus) ? initialStatus : 'all'
  );

  const [period, setPeriod] = useState<Period>('this_month');
  const [customRange, setCustomRange] = useState<ResolvedDateRange | undefined>(undefined);

  const [expenses, setExpenses] = useState<ExpenseRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

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
    const resolved = resolveDateRange(period, customRange);
    // Calendar days: `expenseDate` is a date, not an instant (see the route).
    const qs = new URLSearchParams({
      perPage: '50',
      from: toDateStr(resolved.startDate),
      to: toDateStr(resolved.endDate),
    });
    if (statusFilter !== 'all') qs.set('status', statusFilter);
    setError(null);
    apiGet<ExpenseRow[]>(`/api/v1/stores/${storeId}/expenses?${qs}`)
      .then(({ data, error: apiError }) => {
        if (!isLatest()) return;
        if (apiError) {
          setExpenses(null);
          setError(apiError.message);
        } else {
          setExpenses(data ?? []);
        }
      })
      .catch(() => {
        if (!isLatest()) return;
        setExpenses(null);
        setError('Failed to load expenses');
      });
  }, [storeId, period, customRange, statusFilter, beginRequest]);

  useEffect(() => {
    fetchExpenses();
  }, [fetchExpenses]);

  async function performAction(expenseId: string, action: 'approve' | 'post' | 'reject') {
    if (action === 'reject') {
      if (!window.confirm(t('actions.rejectConfirm'))) return;
    }
    setActionLoading(expenseId + ':' + action);
    try {
      const { error: apiError } = await apiPost(
        `/api/v1/stores/${storeId}/expenses/${expenseId}/${action}`
      );
      if (apiError) {
        alert(apiError.message);
      } else {
        fetchExpenses();
      }
    } catch {
      alert('Action failed');
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
      cell: exp => <span className="font-mono">{kwd(exp.amount)}</span>,
    },
    {
      header: t('tax'),
      hideOnMobile: true,
      alignEnd: true,
      cell: exp => <span className="font-mono">{kwd(exp.taxAmount)}</span>,
    },
    {
      header: t('total'),
      alignEnd: true,
      cell: exp => <span className="font-mono font-medium">{kwd(exp.totalAmount)}</span>,
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
          <div className="flex gap-1">
            {(exp.status === 'draft' || exp.status === 'pending') && (
              <button
                type="button"
                disabled={isActing}
                onClick={() => performAction(exp.id, 'approve')}
                className="max-md:min-h-11 px-2 py-1 max-md:px-3 text-xs border border-border rounded hover:bg-muted disabled:opacity-50"
              >
                {t('actions.approve')}
              </button>
            )}
            {exp.status === 'approved' && (
              <button
                type="button"
                disabled={isActing}
                onClick={() => performAction(exp.id, 'post')}
                className="max-md:min-h-11 px-2 py-1 max-md:px-3 text-xs border border-border rounded hover:bg-muted disabled:opacity-50"
              >
                {t('actions.post')}
              </button>
            )}
            {exp.status !== 'posted' && exp.status !== 'rejected' && (
              <button
                type="button"
                disabled={isActing}
                onClick={() => performAction(exp.id, 'reject')}
                className="max-md:min-h-11 px-2 py-1 max-md:px-3 text-xs border border-red-200 text-red-600 rounded hover:bg-red-50 disabled:opacity-50"
              >
                {t('actions.reject')}
              </button>
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
        <button
          type="button"
          onClick={() => router.push(`/stores/${storeId}/finance/expenses/new`)}
          className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm font-medium"
        >
          {t('newButton')}
        </button>
      }
    >
      <DateRangePicker
        period={period}
        custom={customRange}
        onChange={(p, c) => {
          setPeriod(p);
          if (c) setCustomRange(c);
        }}
      />

      <label className="mb-4 flex w-fit items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('status')}</span>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as ExpenseStatus | 'all')}
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
            <DataTable<ExpenseRow>
              ariaLabel={t('title')}
              columns={columns}
              rows={expenses}
              rowKey={exp => exp.id}
            />
          )}
        </div>
      )}
    </AdminLayout>
  );
}
