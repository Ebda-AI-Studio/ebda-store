'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { CartIcon } from '@ebda/ui';
import { formatCurrency, formatNumber, type DashboardStats } from './types';

interface StatCardProps {
  title: string;
  /** `null` renders `unknownLabel` — a figure we cannot compute, never a 0. */
  value: number | null;
  change?: number | null;
  /** Previous-period total; 0 = no baseline for a percentage. */
  previous?: number | null;
  newLabel?: string;
  icon: React.ReactNode;
  iconBg?: string;
  format?: 'number' | 'currency' | 'percentage';
  vsLastPeriodLabel: string;
  unknownLabel?: string;
  /** Explanation under the figure (e.g. why profit is unknown / partial). */
  note?: React.ReactNode;
}

function StatCard({
  title,
  value,
  change,
  previous,
  newLabel,
  icon,
  iconBg = 'bg-primary',
  format = 'number',
  vsLastPeriodLabel,
  unknownLabel,
  note,
}: StatCardProps) {
  const displayValue =
    value === null
      ? (unknownLabel ?? '—')
      : format === 'currency'
        ? formatCurrency(value)
        : format === 'percentage'
          ? `${value.toFixed(1)}%`
          : formatNumber(value);

  // Previous period was 0: the API's +100% is not a percentage. Say "New" when there are sales now, show nothing when both are 0.
  const noBaseline = previous === 0;
  const isNew = noBaseline && (value ?? 0) > 0;
  const showChange = change != null && !noBaseline;
  const isPositive = change != null && change >= 0;

  return (
    <div className="force-stat-card group">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-foreground">{displayValue}</p>
          {isNew && (
            <div className="mt-2 flex items-center gap-1">
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-foreground">
                {newLabel}
              </span>
              <span className="text-xs text-muted-foreground">{vsLastPeriodLabel}</span>
            </div>
          )}
          {showChange && (
            <div className="mt-2 flex items-center gap-1">
              <span
                className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold ${
                  isPositive
                    ? 'bg-success/10 text-success-ink'
                    : 'bg-destructive/5 text-destructive-ink dark:bg-destructive/20 dark:text-destructive-ink'
                }`}
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2.5}
                    d={isPositive ? 'M5 10l7-7m0 0l7 7m-7-7v18' : 'M19 14l-7 7m0 0l-7-7m7 7V3'}
                  />
                </svg>
                {Math.abs(change).toFixed(1)}%
              </span>
              <span className="text-xs text-muted-foreground">{vsLastPeriodLabel}</span>
            </div>
          )}
          {note && <div className="mt-2 text-xs text-muted-foreground">{note}</div>}
        </div>
        <div
          className={`flex h-12 w-12 items-center justify-center rounded-lg ${iconBg} text-white shadow-md transition-transform duration-200 group-hover:scale-110`}
        >
          {icon}
        </div>
      </div>
    </div>
  );
}

interface AnalyticsStatsGridProps {
  stats: DashboardStats | null;
}

/**
 * Four-card summary strip at the top of the analytics page.
 * Icons are inlined as SVGs so we don't introduce an icon library dep.
 */
export function AnalyticsStatsGrid({ stats }: AnalyticsStatsGridProps) {
  const t = useT('analytics.stats');
  const vsLabel = t('vsLastPeriod');
  const newLabel = t('newVsPrevious');
  const params = useParams();
  const storeId = params?.id as string;

  // Profit needs a cost price on every sold line. Say so, and where to fix it,
  // instead of showing 0 (unknown) or a silently partial figure.
  const missingCost = stats?.profitItemsMissingCost ?? 0;
  const profitNote =
    missingCost > 0 ? (
      <>
        <p>
          {stats?.totalProfit == null
            ? t('profitMissingCost', { count: missingCost })
            : t('profitPartial', {
                count: missingCost,
                amount: formatCurrency(stats?.profitRevenueMissingCost ?? 0),
              })}
        </p>
        <Link
          href={`/stores/${storeId}/products`}
          className="mt-1 inline-block font-medium text-primary underline-offset-2 hover:underline"
        >
          {t('addCostPrices')}
        </Link>
      </>
    ) : null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-6 mb-8 stagger-animation">
      <StatCard
        title={t('totalRevenue')}
        value={stats ? stats.totalRevenue : null}
        change={stats?.revenueChange}
        previous={stats?.previousRevenue}
        newLabel={newLabel}
        format="currency"
        iconBg="bg-primary"
        vsLastPeriodLabel={vsLabel}
        icon={
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        }
      />
      <StatCard
        title={t('totalProfit')}
        value={stats ? stats.totalProfit : null}
        change={stats?.profitChange}
        previous={stats?.previousProfit}
        newLabel={newLabel}
        format="currency"
        iconBg="bg-success"
        vsLastPeriodLabel={vsLabel}
        // A missing cost price is a KNOWN reason; failed stats are just unknown.
        unknownLabel={stats ? t('profitUnknown') : undefined}
        note={profitNote}
        icon={
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 17l6-6 4 4 8-8M14 7h7v7"
            />
          </svg>
        }
      />
      <StatCard
        title={t('totalOrders')}
        value={stats ? stats.totalOrders : null}
        change={stats?.ordersChange}
        previous={stats?.previousOrders}
        newLabel={newLabel}
        iconBg="bg-primary"
        vsLastPeriodLabel={vsLabel}
        icon={<CartIcon className="w-5 h-5" />}
      />
      <StatCard
        title={t('totalCustomers')}
        value={stats ? stats.totalCustomers : null}
        change={stats?.customersChange}
        previous={stats?.previousCustomers}
        newLabel={newLabel}
        iconBg="bg-success"
        vsLastPeriodLabel={vsLabel}
        icon={
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
            />
          </svg>
        }
      />
      <StatCard
        title={t('avgOrderValue')}
        value={stats ? stats.averageOrderValue : null}
        format="currency"
        iconBg="bg-info"
        vsLastPeriodLabel={vsLabel}
        icon={
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"
            />
          </svg>
        }
      />
    </div>
  );
}
