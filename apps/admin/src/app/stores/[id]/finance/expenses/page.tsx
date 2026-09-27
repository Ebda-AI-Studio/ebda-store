'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { DateRangePicker } from '@/components/DateRangePicker';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '@/lib/api';
import { filsToKwd } from '@/lib/format';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import type { Period, ResolvedDateRange } from '../../analytics/_components/types';
import { resolveDateRange } from '../../analytics/_components/types';

// ─── Types ────────────────────────────────────────────────────────────────────

type ExpenseStatus = 'draft' | 'pending' | 'approved' | 'posted' | 'rejected';

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
  draft: 'bg-gray-100 text-gray-700',
  pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-blue-100 text-blue-700',
  posted: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function ExpensesPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const t = useT('finance.expenses');
  const tc = useT('common');

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

  const fetchExpenses = useCallback(() => {
    if (!storeId) return;
    const resolved = resolveDateRange(period, customRange);
    const from = toDateStr(resolved.startDate);
    const to = toDateStr(resolved.endDate);
    apiGet<ExpenseRow[]>(`/api/v1/stores/${storeId}/expenses?perPage=50&from=${from}&to=${to}`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else {
          setExpenses(data ?? []);
        }
      })
      .catch(() => setError('Failed to load expenses'));
  }, [storeId, period, customRange]);

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

      {error && (
        <div className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
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
            <DataTable<ExpenseRow> columns={columns} rows={expenses} rowKey={exp => exp.id} />
          )}
        </div>
      )}
    </AdminLayout>
  );
}
