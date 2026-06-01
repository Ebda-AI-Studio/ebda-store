'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { apiGet } from '../../../../../lib/api';
import { useRequireFeature } from '../../../../../hooks/useRequireFeature';

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

// Bilingual type labels
const TYPE_LABELS: Record<string, string> = {
  all: 'All Types / جميع الأنواع',
  earn_purchase: 'Earn: Purchase / ربح: شراء',
  earn_signup: 'Earn: Sign-up / ربح: تسجيل',
  earn_referral: 'Earn: Referral / ربح: إحالة',
  earn_review: 'Earn: Review / ربح: تقييم',
  earn_birthday: 'Earn: Birthday / ربح: عيد ميلاد',
  earn_manual: 'Earn: Manual / ربح: يدوي',
  redeem_discount: 'Redeem: Discount / استرداد: خصم',
  redeem_product: 'Redeem: Product / استرداد: منتج',
  expire: 'Expired / منتهي الصلاحية',
  adjust: 'Adjustment / تعديل',
  tier_changed: 'Tier Changed / تغيير المستوى',
};

function TypeBadge({ type }: { type: string }) {
  let className = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ';
  if (type === 'tier_changed') {
    className += 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300';
  } else if (type.startsWith('earn_')) {
    className += 'bg-success/10 text-success';
  } else if (type.startsWith('redeem_')) {
    className += 'bg-info/10 text-info';
  } else if (type === 'expire') {
    className += 'bg-destructive/10 text-destructive';
  } else {
    className += 'bg-muted text-muted-foreground';
  }
  return <span className={className}>{TYPE_LABELS[type] ?? type}</span>;
}

function PointsCell({ points }: { points: number }) {
  if (points > 0)
    return <span className="font-semibold text-emerald-600 dark:text-emerald-400">+{points}</span>;
  if (points < 0) return <span className="font-semibold text-destructive">{points}</span>;
  return <span className="text-muted-foreground">0</span>;
}

export default function LoyaltyTransactionsPage() {
  const { gate } = useRequireFeature('loyalty');

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

  const fetchTransactions = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set('page', String(page));
      qs.set('limit', '50');
      if (typeFilter !== 'all') qs.set('type', typeFilter);
      if (customerFilter.trim()) qs.set('customerId', customerFilter.trim());
      if (dateFrom) qs.set('from', dateFrom);
      if (dateTo) qs.set('to', dateTo);

      const { data } = await apiGet<{ transactions: LoyaltyTransaction[]; meta: Meta }>(
        `/api/v1/stores/${storeId}/loyalty/transactions?${qs}`
      );
      if (data) {
        setTransactions(data.transactions ?? []);
        setMeta(data.meta ?? null);
      }
    } catch {
      // error shown via empty state
    } finally {
      setLoading(false);
    }
  }, [storeId, page, typeFilter, customerFilter, dateFrom, dateTo]);

  useEffect(() => {
    fetchTransactions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, typeFilter, dateFrom, dateTo]);

  // Reset page when filters change
  const handleFilterChange = (setter: (v: string) => void, value: string) => {
    setPage(1);
    setter(value);
  };

  const handleCustomerSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchTransactions();
  };

  if (gate) return gate;

  return (
    <AdminLayout
      mode="store_admin"
      storeId={storeId}
      title="Transactions / المعاملات"
      subtitle="Loyalty Program / برنامج الولاء"
    >
      <div className="mx-auto max-w-7xl px-4 pb-12 pt-4 sm:px-6">
        {/* Breadcrumb */}
        <nav className="mb-5 flex items-center gap-2 text-sm text-muted-foreground">
          <Link
            href={`/stores/${storeId}/loyalty`}
            className="hover:text-foreground transition-colors"
          >
            Loyalty / الولاء
          </Link>
          <span>/</span>
          <span className="text-foreground">Transactions / المعاملات</span>
        </nav>

        {/* Filters */}
        <div className="mb-6 flex flex-wrap gap-3">
          {/* Type filter */}
          <select
            value={typeFilter}
            onChange={e => handleFilterChange(setTypeFilter, e.target.value)}
            aria-label="Filter by transaction type"
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {TYPE_FILTERS.map(t => (
              <option key={t} value={t}>
                {TYPE_LABELS[t] ?? t}
              </option>
            ))}
          </select>

          {/* Date from */}
          <input
            type="date"
            value={dateFrom}
            onChange={e => handleFilterChange(setDateFrom, e.target.value)}
            aria-label="From date"
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />

          {/* Date to */}
          <input
            type="date"
            value={dateTo}
            onChange={e => handleFilterChange(setDateTo, e.target.value)}
            aria-label="To date"
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />

          {/* Customer search */}
          <form onSubmit={handleCustomerSearch} className="flex gap-2">
            <input
              type="text"
              value={customerFilter}
              onChange={e => setCustomerFilter(e.target.value)}
              placeholder="Customer ID..."
              aria-label="Filter by customer ID"
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <button
              type="submit"
              className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors"
            >
              Search
            </button>
          </form>
        </div>

        {/* Table */}
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
            </div>
          ) : transactions.length === 0 ? (
            <div className="p-12 text-center">
              <p className="text-muted-foreground">No transactions found / لا توجد معاملات</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full" aria-label="Loyalty transactions">
                  <thead>
                    <tr className="border-b border-border bg-muted">
                      <th
                        scope="col"
                        className="px-4 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
                      >
                        Date / التاريخ
                      </th>
                      <th
                        scope="col"
                        className="px-4 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
                      >
                        Customer / العميل
                      </th>
                      <th
                        scope="col"
                        className="px-4 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
                      >
                        Order # / الطلب
                      </th>
                      <th
                        scope="col"
                        className="px-4 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
                      >
                        Type / النوع
                      </th>
                      <th
                        scope="col"
                        className="px-4 py-3 text-end text-xs font-medium text-muted-foreground uppercase tracking-wider"
                      >
                        Points / النقاط
                      </th>
                      <th
                        scope="col"
                        className="px-4 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
                      >
                        Description / الوصف
                      </th>
                      <th
                        scope="col"
                        className="px-4 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider"
                      >
                        Expires / الانتهاء
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {transactions.map(tx => (
                      <tr key={tx.id} className="hover:bg-muted/50">
                        <td className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
                          {new Date(tx.createdAt).toLocaleDateString('en-US', {
                            dateStyle: 'medium',
                          })}
                        </td>
                        <td className="px-4 py-3">
                          <div className="text-sm font-medium text-foreground">
                            {[tx.customer.firstName, tx.customer.lastName]
                              .filter(Boolean)
                              .join(' ') || '—'}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {tx.customer.email ?? ''}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {tx.order ? (
                            <Link
                              href={`/stores/${storeId}/orders/${tx.order.id}`}
                              className="text-primary hover:underline font-mono text-xs"
                            >
                              {tx.order.orderNumber}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <TypeBadge type={tx.type} />
                        </td>
                        <td className="px-4 py-3 text-end text-sm font-mono">
                          <PointsCell points={tx.points} />
                        </td>
                        <td className="px-4 py-3 text-sm text-muted-foreground max-w-xs truncate">
                          {tx.description ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
                          {tx.expiresAt
                            ? new Date(tx.expiresAt).toLocaleDateString('en-US', {
                                dateStyle: 'medium',
                              })
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {meta && meta.totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-border bg-muted px-4 py-3">
                  <p className="text-sm text-muted-foreground">
                    Page {meta.page} of {meta.totalPages} &mdash; {meta.total.toLocaleString()}{' '}
                    total
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      disabled={page <= 1}
                      className="rounded border border-border px-3 py-1 text-sm disabled:opacity-50 hover:bg-card"
                    >
                      Previous / السابق
                    </button>
                    <button
                      type="button"
                      onClick={() => setPage(p => Math.min(meta.totalPages, p + 1))}
                      disabled={page >= meta.totalPages}
                      className="rounded border border-border px-3 py-1 text-sm disabled:opacity-50 hover:bg-card"
                    >
                      Next / التالي
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </AdminLayout>
  );
}
