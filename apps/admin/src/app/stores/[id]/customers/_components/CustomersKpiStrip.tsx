'use client';

import { useT } from '@/i18n/useT';
import { formatPrice, formatNumber } from '@/lib/format';

/** Mirrors `CustomersSummary` in apps/api/src/routes/customers.routes.ts. */
export interface CustomersSummary {
  customers: number;
  guests: number;
  buyers: number;
  repeatBuyers: number;
  /** 0..1, or null when the store has no buyers (unknown, not 0%). */
  repeatRate: number | null;
  orders: number;
  /** Piastres. */
  totalSpent: number;
  /** Piastres, or null when there are no counted orders. */
  avgOrderValue: number | null;
}

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  /** True when the value is unknown — rendered muted so it never reads as a real 0. */
  unknown?: boolean;
}

function KpiCard({ label, value, sub, unknown }: KpiCardProps) {
  return (
    <div className="rounded-md border border-border bg-card p-3 sm:p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p
        className={`mt-1 text-lg font-bold sm:text-xl ${
          unknown ? 'text-muted-foreground' : 'text-foreground'
        }`}
      >
        <bdi>{value}</bdi>
      </p>
      {sub && <p className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

interface CustomersKpiStripProps {
  /** Null while loading, or when the list request failed (then: unknown). */
  summary: CustomersSummary | null;
  isLoading: boolean;
  /** The server capped the order scan — figures cover recent orders only. */
  truncated: boolean;
}

/**
 * Four store-wide KPIs above the Customers table. Every figure comes from the
 * API's `meta.summary` — nothing is estimated client-side, and a figure the
 * server could not compute (no buyers → no repeat rate; failed request) is
 * shown as "Unknown", never as a fabricated 0.
 */
export function CustomersKpiStrip({ summary, isLoading, truncated }: CustomersKpiStripProps) {
  const t = useT('customers.page.kpi');

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-hidden="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-md border border-border bg-card p-3 sm:p-4">
            <div className="force-skeleton h-3 w-20" />
            <div className="force-skeleton mt-2 h-6 w-24" />
            <div className="force-skeleton mt-1.5 h-3 w-16" />
          </div>
        ))}
      </div>
    );
  }

  const unknown = t('unknown');
  const partial = truncated ? t('partial') : undefined;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="customers-kpi-strip">
      <KpiCard
        label={t('customers')}
        value={summary ? formatNumber(summary.customers) : unknown}
        unknown={!summary}
        sub={partial ?? (summary ? t('guestsSub', { count: summary.guests }) : undefined)}
      />
      <KpiCard
        label={t('repeatRate')}
        value={summary?.repeatRate != null ? `${Math.round(summary.repeatRate * 100)}%` : unknown}
        unknown={summary?.repeatRate == null}
        sub={
          partial ??
          (summary && summary.buyers > 0
            ? t('repeatSub', { repeat: summary.repeatBuyers, buyers: summary.buyers })
            : summary
              ? t('noBuyersSub')
              : undefined)
        }
      />
      <KpiCard
        label={t('avgOrderValue')}
        value={summary?.avgOrderValue != null ? formatPrice(summary.avgOrderValue) : unknown}
        unknown={summary?.avgOrderValue == null}
        sub={partial ?? (summary ? t('ordersSub', { count: summary.orders }) : undefined)}
      />
      <KpiCard
        label={t('totalSpent')}
        value={summary ? formatPrice(summary.totalSpent) : unknown}
        unknown={!summary}
        sub={partial ?? t('spentSub')}
      />
    </div>
  );
}
