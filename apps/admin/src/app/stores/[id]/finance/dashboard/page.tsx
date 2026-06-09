'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { DateRangePicker } from '@/components/DateRangePicker';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';
import type { Period, ResolvedDateRange } from '../../analytics/_components/types';
import { resolveDateRange } from '../../analytics/_components/types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CashAccountRow {
  code: string;
  nameEn: string;
  nameAr: string | null;
  balance: number;
}

interface DashboardData {
  // The API field is still named `thisMonth` for backward-compat.
  // It reflects whatever window the caller requested via from/to params.
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

interface ProfitAnomaly {
  id: string;
  metric: string;
  severity: 'p0' | 'warning';
  deltaPercent: number;
  explanationEn: string;
  acknowledged: boolean;
  detectedAt: string;
}

/**
 * Subset of the analytics/dashboard stats needed for the sales reconciliation
 * panel. The full analytics endpoint returns more fields but we only surface
 * the order-level revenue, order count, and paid total here.
 */
interface SalesStats {
  totalRevenue: number;
  totalOrders: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function kwd(fils: number | null | undefined): string {
  if (typeof fils !== 'number' || !Number.isFinite(fils)) return '0.000';
  return (fils / 1000).toFixed(3);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function FinanceDashboardPage() {
  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;
  const t = useT('finance.dashboard');
  const tc = useT('common');

  const [period, setPeriod] = useState<Period>('this_month');
  const [customRange, setCustomRange] = useState<ResolvedDateRange | undefined>(undefined);

  const [data, setData] = useState<DashboardData | null>(null);
  // Per-card error state: main dashboard fetch failure used to blank
  // the entire page via {data && ...}. Now the KPI/chart sections always
  // render; a failed main fetch shows "—" in each card + a per-card
  // "Couldn't load" hint (title= carries the raw error for hover-debug).
  // Anomalies + OCR sections are already defensive — untouched.
  const [dashboardErr, setDashboardErr] = useState<string | null>(null);
  const [recentAnomalies, setRecentAnomalies] = useState<ProfitAnomaly[]>([]);
  const [pendingOcrCount, setPendingOcrCount] = useState<number | null>(null);
  /**
   * Sales revenue from actual paid orders (analytics endpoint). Shown alongside
   * the accounting P&L so merchants without posted journal entries can still see
   * real sales figures. The two numbers intentionally differ: analytics uses
   * paid-order totals while accounting uses double-entry journal entries.
   */
  const [salesStats, setSalesStats] = useState<SalesStats | null>(null);

  // Build YYYY-MM-DD strings from the resolved date range.
  function toDateStr(d: Date): string {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  useEffect(() => {
    if (!storeId) return;

    setData(null);
    setDashboardErr(null);

    const resolved = resolveDateRange(period, customRange);
    const from = toDateStr(resolved.startDate);
    const to = toDateStr(resolved.endDate);

    // Main dashboard — pass the resolved date window
    apiGet<DashboardData>(`/api/v1/stores/${storeId}/finance/dashboard?from=${from}&to=${to}`)
      .then(({ data: d, error: apiError }) => {
        if (apiError) {
          setDashboardErr(apiError.message);
        } else if (d) {
          setData(d);
        }
      })
      .catch(() => setDashboardErr('Failed to load finance dashboard'));

    // Sales stats from the canonical analytics endpoint. This is the same
    // source used by the Analytics hub — paid order totals from the orders
    // table, NOT from accounting journal entries. Merchants without posted
    // journal entries will see $0 in the P&L section above but real numbers
    // here. Both numbers are intentionally surfaced so the merchant can
    // reconcile them. Failure is best-effort — the panel simply disappears.
    apiGet<{ stats?: { totalRevenue?: number; totalOrders?: number } }>(
      `/api/v1/stores/${storeId}/analytics/dashboard?startDate=${resolved.startDate.toISOString()}&endDate=${resolved.endDate.toISOString()}`
    )
      .then(({ data: ad }) => {
        const s = ad?.stats;
        if (s && typeof s.totalRevenue === 'number') {
          setSalesStats({ totalRevenue: s.totalRevenue, totalOrders: s.totalOrders ?? 0 });
        }
      })
      .catch(() => {
        // best-effort — panel stays hidden on failure
      });

    // Recent unacknowledged anomalies (top 3) — defensive against missing
    // `data` field on the API response (e.g. anomalies feature not yet
    // enabled for this store, error responses, partial shape).
    apiGet<{ data?: ProfitAnomaly[]; meta?: { total: number } }>(
      `/api/v1/stores/${storeId}/finance/anomalies?acknowledged=false&perPage=3&page=1`
    ).then(({ data: ad }) => {
      if (ad?.data && Array.isArray(ad.data)) setRecentAnomalies(ad.data);
    });

    // Pending OCR drafts count — defensive against missing `meta` field.
    apiGet<{ meta?: { total: number } }>(
      `/api/v1/stores/${storeId}/expenses?status=draft&hasOcr=true&perPage=1&page=1`
    ).then(({ data: ed }) => {
      if (ed?.meta?.total !== undefined) setPendingOcrCount(ed.meta.total);
    });
  }, [storeId, period, customRange]);

  // Defensive destructure — API can return partial shape for stores with
  // incomplete accounting setup (no COA seeded, no journal entries yet,
  // backorder-test stores etc.). Defaults keep the page renderable
  // instead of crashing on `cash.length` or `thisMonth.net`.
  const thisMonth = data?.thisMonth ?? { revenue: 0, expenses: 0, net: 0 };
  const cash = Array.isArray(data?.cash) ? data.cash : [];
  const stockValue = typeof data?.stockValue === 'number' ? data.stockValue : 0;
  const balanceSheet = data?.balanceSheet ?? {
    totalAssets: 0,
    totalLiabilities: 0,
    totalEquity: 0,
  };
  const netPositive = thisMonth.net >= 0;

  return (
    <AdminLayout title={t('title')}>
      <DateRangePicker
        period={period}
        custom={customRange}
        onChange={(p, c) => {
          setPeriod(p);
          if (c) setCustomRange(c);
        }}
      />

      {/* Loading state — only while no response (success OR error) has arrived */}
      {!data && !dashboardErr && (
        <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
      )}

      {/* Always render the dashboard sections once any response has landed.
          Cards show "—" + "Couldn't load" when dashboardErr is set so the
          anomaly / OCR widgets (already defensive) keep rendering regardless. */}
      {(data || dashboardErr) && (
        <div className="max-w-5xl space-y-6">
          {/* P&L window KPIs */}
          <section>
            <h2 className="text-base font-semibold mb-3">{t('thisMonth')}</h2>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Revenue */}
              <div className="rounded-xl border border-border p-4 space-y-1">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  {t('revenue')}
                </p>
                <p
                  className={`text-2xl font-semibold font-mono ${dashboardErr ? 'text-muted-foreground' : 'text-green-700'}`}
                  title={dashboardErr ?? undefined}
                >
                  {dashboardErr ? '—' : kwd(thisMonth.revenue)}
                </p>
                {dashboardErr ? (
                  <p className="text-xs text-destructive truncate" title={dashboardErr}>
                    Couldn't load
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">KWD</p>
                )}
              </div>

              {/* Expenses */}
              <div className="rounded-xl border border-border p-4 space-y-1">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">
                  {t('expenses')}
                </p>
                <p
                  className={`text-2xl font-semibold font-mono ${dashboardErr ? 'text-muted-foreground' : 'text-red-600'}`}
                  title={dashboardErr ?? undefined}
                >
                  {dashboardErr ? '—' : kwd(thisMonth.expenses)}
                </p>
                {dashboardErr ? (
                  <p className="text-xs text-destructive truncate" title={dashboardErr}>
                    Couldn't load
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">KWD</p>
                )}
              </div>

              {/* Net Income */}
              <div className="rounded-xl border border-border p-4 space-y-1">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('net')}</p>
                <p
                  className={`text-2xl font-semibold font-mono ${dashboardErr ? 'text-muted-foreground' : netPositive ? 'text-green-700' : 'text-red-600'}`}
                  title={dashboardErr ?? undefined}
                >
                  {dashboardErr ? (
                    '—'
                  ) : (
                    <>
                      {netPositive ? '' : '−'}
                      {kwd(Math.abs(thisMonth.net))}
                    </>
                  )}
                </p>
                {dashboardErr ? (
                  <p className="text-xs text-destructive truncate" title={dashboardErr}>
                    Couldn't load
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">KWD</p>
                )}
              </div>
            </div>
          </section>

          {/* ── Sales Orders reconciliation ──────────────────────────────
               Canonical order-based revenue from the analytics endpoint.
               This matches the numbers shown in the Analytics hub and is
               based on PAID orders in the orders table — completely separate
               from the double-entry journal entries above.
               When journal entries haven't been posted yet, this panel is
               the source of truth for actual sales. Both panels are shown
               together so the merchant can reconcile them over time.
          ─────────────────────────────────────────────────────────────── */}
          {salesStats && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <h2 className="text-base font-semibold">{t('salesOrdersTitle')}</h2>
                <span className="rounded-full bg-info/10 px-2 py-0.5 text-xs font-medium text-info">
                  {t('salesOrdersSource')}
                </span>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="rounded-xl border border-border p-4 space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">
                    {t('salesOrdersRevenue')}
                  </p>
                  <p className="text-2xl font-semibold font-mono text-green-700">
                    {kwd(salesStats.totalRevenue)}
                  </p>
                  <p className="text-xs text-muted-foreground">KWD</p>
                </div>
                <div className="rounded-xl border border-border p-4 space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">
                    {t('salesOrdersCount')}
                  </p>
                  <p className="text-2xl font-semibold font-mono text-foreground">
                    {salesStats.totalOrders.toLocaleString()}
                  </p>
                  <p className="text-xs text-muted-foreground">{t('salesOrdersCountUnit')}</p>
                </div>
              </div>
            </section>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Stock Value */}
            <section>
              <h2 className="text-base font-semibold mb-3">{t('stockValue')}</h2>
              <div className="rounded-xl border border-border p-6 flex items-center justify-center">
                <div className="text-center space-y-1">
                  <p
                    className={`text-3xl font-semibold font-mono ${dashboardErr ? 'text-muted-foreground' : ''}`}
                    title={dashboardErr ?? undefined}
                  >
                    {dashboardErr ? '—' : kwd(stockValue)}
                  </p>
                  {dashboardErr ? (
                    <p className="text-xs text-destructive truncate" title={dashboardErr}>
                      Couldn't load
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">KWD</p>
                  )}
                </div>
              </div>
            </section>

            {/* Cash by Account */}
            <section>
              <h2 className="text-base font-semibold mb-3">{t('cash')}</h2>
              <div className="rounded-xl border border-border overflow-hidden">
                {dashboardErr ? (
                  <div className="p-4 text-sm text-muted-foreground" title={dashboardErr}>
                    — <span className="text-xs text-destructive">Couldn't load</span>
                  </div>
                ) : cash.length === 0 ? (
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
                {(
                  [
                    { labelKey: 'assets', val: balanceSheet.totalAssets },
                    { labelKey: 'liabilities', val: balanceSheet.totalLiabilities },
                    { labelKey: 'equity', val: balanceSheet.totalEquity },
                  ] as { labelKey: 'assets' | 'liabilities' | 'equity'; val: number }[]
                ).map(({ labelKey, val }) => (
                  <div key={labelKey} className="rounded-xl border border-border p-4 space-y-1">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">
                      {t(labelKey)}
                    </p>
                    <p
                      className={`text-xl font-semibold font-mono ${dashboardErr ? 'text-muted-foreground' : ''}`}
                      title={dashboardErr ?? undefined}
                    >
                      {dashboardErr ? '—' : kwd(val)}
                    </p>
                    {dashboardErr ? (
                      <p className="text-xs text-destructive truncate" title={dashboardErr}>
                        Couldn't load
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">KWD</p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* ── Smart layer cards ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Recent anomalies — already defensive, unchanged */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-semibold">{t('recentAnomalies')}</h2>
                <button
                  type="button"
                  onClick={() => router.push(`/stores/${storeId}/finance/anomalies`)}
                  className="text-xs text-primary hover:underline"
                >
                  {t('viewAll')}
                </button>
              </div>
              <div className="rounded-xl border border-border overflow-hidden">
                {recentAnomalies.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">—</div>
                ) : (
                  <div className="divide-y divide-border/40">
                    {recentAnomalies.map(a => {
                      const sign = a.deltaPercent >= 0 ? '+' : '';
                      // `deltaPercent` is stored as a ratio (e.g. -0.35); ×100
                      // to show a real percentage, matching the anomalies page.
                      const deltaPercentDisplay = a.deltaPercent * 100;
                      return (
                        <div key={a.id} className="px-3 py-2 space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span
                              className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                                a.severity === 'p0'
                                  ? 'bg-red-100 text-red-700'
                                  : 'bg-amber-100 text-amber-700'
                              }`}
                            >
                              {a.severity.toUpperCase()}
                            </span>
                            <span className="text-sm font-medium capitalize">
                              {a.metric.replace(/_/g, ' ')}
                            </span>
                            <span
                              className={`text-xs font-mono ms-auto ${
                                a.deltaPercent < 0 ? 'text-red-600' : 'text-green-700'
                              }`}
                            >
                              {sign}
                              {deltaPercentDisplay.toFixed(1)}%
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground line-clamp-1">
                            {a.explanationEn}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            {/* Pending OCR drafts — already defensive, unchanged */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-semibold">{t('pendingOcrDrafts')}</h2>
                <button
                  type="button"
                  onClick={() => router.push(`/stores/${storeId}/finance/expenses?status=draft`)}
                  className="text-xs text-primary hover:underline"
                >
                  {t('viewAll')}
                </button>
              </div>
              <div className="rounded-xl border border-border p-6 flex items-center justify-center">
                <div className="text-center space-y-1">
                  {pendingOcrCount === null ? (
                    <p className="text-sm text-muted-foreground">{tc('loading')}</p>
                  ) : (
                    <>
                      <p className="text-3xl font-semibold font-mono">{pendingOcrCount}</p>
                      <p className="text-sm text-muted-foreground">{t('pendingOcrDrafts')}</p>
                    </>
                  )}
                </div>
              </div>
            </section>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
