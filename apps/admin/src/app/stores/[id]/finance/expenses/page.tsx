'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '@/lib/api';

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

function kwd(fils: number): string {
  return (fils / 1000).toFixed(3);
}

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

  const [expenses, setExpenses] = useState<ExpenseRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchExpenses = useCallback(() => {
    if (!storeId) return;
    apiGet<ExpenseRow[]>(`/api/v1/stores/${storeId}/expenses?perPage=50`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else {
          setExpenses(data ?? []);
        }
      })
      .catch(() => setError('Failed to load expenses'));
  }, [storeId]);

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

  if (error) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-red-600 text-sm">{error}</div>
      </AdminLayout>
    );
  }

  if (!expenses) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
      </AdminLayout>
    );
  }

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
      <div className="max-w-6xl">
        {expenses.length === 0 ? (
          <p className="text-muted-foreground text-sm">No expenses yet.</p>
        ) : (
          <div className="rounded-xl border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/30">
                  <tr>
                    <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                      {t('number')}
                    </th>
                    <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                      {t('date')}
                    </th>
                    <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                      {t('vendor')}
                    </th>
                    <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                      {t('category')}
                    </th>
                    <th className="text-end px-3 py-2 font-medium text-muted-foreground">
                      {t('amount')}
                    </th>
                    <th className="text-end px-3 py-2 font-medium text-muted-foreground">
                      {t('tax')}
                    </th>
                    <th className="text-end px-3 py-2 font-medium text-muted-foreground">
                      {t('total')}
                    </th>
                    <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                      {t('status')}
                    </th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {expenses.map(exp => {
                    const isActing = actionLoading?.startsWith(exp.id + ':');
                    return (
                      <tr key={exp.id} className="border-t border-border/40">
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                          {exp.expenseNumber}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {exp.expenseDate?.slice(0, 10)}
                        </td>
                        <td className="px-3 py-2">{exp.supplier?.name ?? '—'}</td>
                        <td className="px-3 py-2">{exp.expenseAccount?.nameEn ?? '—'}</td>
                        <td className="px-3 py-2 text-end font-mono">{kwd(exp.amount)}</td>
                        <td className="px-3 py-2 text-end font-mono">{kwd(exp.taxAmount)}</td>
                        <td className="px-3 py-2 text-end font-mono font-medium">
                          {kwd(exp.totalAmount)}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[exp.status]}`}
                          >
                            {t(`statuses.${exp.status}`)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex gap-1">
                            {(exp.status === 'draft' || exp.status === 'pending') && (
                              <button
                                type="button"
                                disabled={isActing}
                                onClick={() => performAction(exp.id, 'approve')}
                                className="px-2 py-1 text-xs border border-border rounded hover:bg-muted disabled:opacity-50"
                              >
                                {t('actions.approve')}
                              </button>
                            )}
                            {exp.status === 'approved' && (
                              <button
                                type="button"
                                disabled={isActing}
                                onClick={() => performAction(exp.id, 'post')}
                                className="px-2 py-1 text-xs border border-border rounded hover:bg-muted disabled:opacity-50"
                              >
                                {t('actions.post')}
                              </button>
                            )}
                            {exp.status !== 'posted' && exp.status !== 'rejected' && (
                              <button
                                type="button"
                                disabled={isActing}
                                onClick={() => performAction(exp.id, 'reject')}
                                className="px-2 py-1 text-xs border border-red-200 text-red-600 rounded hover:bg-red-50 disabled:opacity-50"
                              >
                                {t('actions.reject')}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
