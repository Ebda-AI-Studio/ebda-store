'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CashAccountRow {
  code: string;
  nameEn: string;
  nameAr: string | null;
  balance: number;
}

interface DashboardData {
  thisMonth: {
    revenue: number;
    expenses: number;
    net: number;
  };
  cash: CashAccountRow[];
  stockValue: number;
  balanceSheet: {
    totalAssets: number;
    totalLiabilities: number;
    totalEquity: number;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function kwd(fils: number): string {
  return (fils / 1000).toFixed(3);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function FinanceDashboardPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('finance.dashboard');
  const tc = useT('common');

  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId) return;
    apiGet<DashboardData>(`/api/v1/stores/${storeId}/finance/dashboard`)
      .then(({ data: d, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else if (d) {
          setData(d);
        }
      })
      .catch(() => setError('Failed to load finance dashboard'));
  }, [storeId]);

  if (error) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-red-600 text-sm">{error}</div>
      </AdminLayout>
    );
  }

  if (!data) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
      </AdminLayout>
    );
  }

  const { thisMonth, cash, stockValue, balanceSheet } = data;
  const netPositive = thisMonth.net >= 0;

  return (
    <AdminLayout title={t('title')}>
      <div className="max-w-5xl space-y-6">
        {/* This Month KPIs */}
        <section>
          <h2 className="text-base font-semibold mb-3">{t('thisMonth')}</h2>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Revenue */}
            <div className="rounded-xl border border-border p-4 space-y-1">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                {t('revenue')}
              </p>
              <p className="text-2xl font-semibold font-mono text-green-700">
                {kwd(thisMonth.revenue)}
              </p>
              <p className="text-xs text-muted-foreground">KWD</p>
            </div>

            {/* Expenses */}
            <div className="rounded-xl border border-border p-4 space-y-1">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                {t('expenses')}
              </p>
              <p className="text-2xl font-semibold font-mono text-red-600">
                {kwd(thisMonth.expenses)}
              </p>
              <p className="text-xs text-muted-foreground">KWD</p>
            </div>

            {/* Net Income */}
            <div className="rounded-xl border border-border p-4 space-y-1">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('net')}</p>
              <p
                className={`text-2xl font-semibold font-mono ${netPositive ? 'text-green-700' : 'text-red-600'}`}
              >
                {netPositive ? '' : '−'}
                {kwd(Math.abs(thisMonth.net))}
              </p>
              <p className="text-xs text-muted-foreground">KWD</p>
            </div>
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Stock Value */}
          <section>
            <h2 className="text-base font-semibold mb-3">{t('stockValue')}</h2>
            <div className="rounded-xl border border-border p-6 flex items-center justify-center">
              <div className="text-center space-y-1">
                <p className="text-3xl font-semibold font-mono">{kwd(stockValue)}</p>
                <p className="text-sm text-muted-foreground">KWD</p>
              </div>
            </div>
          </section>

          {/* Cash by Account */}
          <section>
            <h2 className="text-base font-semibold mb-3">{t('cash')}</h2>
            <div className="rounded-xl border border-border overflow-hidden">
              {cash.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">—</div>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {cash.map((row, i) => {
                      const isNeg = row.balance < 0;
                      return (
                        <tr key={i} className="border-b border-border/40 last:border-0">
                          <td className="px-3 py-2 font-mono text-xs text-muted-foreground w-16">
                            {row.code}
                          </td>
                          <td className="px-3 py-2">
                            {row.nameEn}
                            {row.nameAr && (
                              <span className="text-muted-foreground ms-2 text-xs" dir="rtl">
                                — {row.nameAr}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-end font-mono">
                            <span
                              className={isNeg ? 'text-red-600' : ''}
                              title={isNeg ? t('negativeBalanceTooltip') : undefined}
                            >
                              {isNeg && (
                                <span className="inline-flex items-center me-1 px-1 py-0.5 text-xs bg-red-100 text-red-700 rounded">
                                  !
                                </span>
                              )}
                              {kwd(row.balance)} KWD
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          {/* Balance Sheet Summary */}
          <section className="lg:col-span-2">
            <h2 className="text-base font-semibold mb-3">{t('balanceSheet')}</h2>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="rounded-xl border border-border p-4 space-y-1">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  {t('assets')}
                </p>
                <p className="text-xl font-semibold font-mono">{kwd(balanceSheet.totalAssets)}</p>
                <p className="text-xs text-muted-foreground">KWD</p>
              </div>
              <div className="rounded-xl border border-border p-4 space-y-1">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  {t('liabilities')}
                </p>
                <p className="text-xl font-semibold font-mono">
                  {kwd(balanceSheet.totalLiabilities)}
                </p>
                <p className="text-xs text-muted-foreground">KWD</p>
              </div>
              <div className="rounded-xl border border-border p-4 space-y-1">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  {t('equity')}
                </p>
                <p className="text-xl font-semibold font-mono">{kwd(balanceSheet.totalEquity)}</p>
                <p className="text-xs text-muted-foreground">KWD</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </AdminLayout>
  );
}
