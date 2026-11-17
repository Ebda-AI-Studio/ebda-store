'use client';

/**
 * Super-admin store usage history — /usage-history (issue 1058).
 *
 * The `store-usage-snapshot` cron writes one `store_usage_snapshots` row per
 * store per month (catalogue size, orders, revenue, traffic proxies, AI
 * calls + spend) so plan-tier ceilings can be sized from what merchants
 * actually do. The rows had an API (`GET /admin/super-admin/usage-history`)
 * and no viewer; this is the viewer: pick a month, see every store's row.
 *
 * Unknown stays unknown: the API returns EVERY snapshot row of each month it
 * returns (paged by period, not by a row budget), so a store absent from a
 * month has no snapshot for it; AI spend with unpriced calls is labelled a
 * floor, same as the platform AI page.
 *
 * Route guard: super_admin only (RequireSuperAdmin + the API's requireRole).
 */

import { intlLocaleForUi } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale } from 'next-intl';
import { AdminLayout } from '../../components/AdminLayout';
import { RequireSuperAdmin } from '../../components/RequireSuperAdmin';
import { apiGet } from '../../lib/api';
import { DataTable, type DataTableColumn } from '../../components/mobile/DataTable';
import { useT } from '../../i18n/useT';
import { formatSpend } from '@/lib/ai-spend';

import { formatMoney, withNumerals } from '@ebda/shared';
interface UsageStoreRow {
  storeId: string;
  slug: string;
  name: string;
  plan: string;
  products: number;
  productsActive: number;
  variants: number;
  images: number;
  categories: number;
  orders: number;
  /** BigInt serialised as a string (piastres). */
  revenueFils: string;
  customers: number;
  sessionsProxy: number;
  cartsWithItems: number;
  /** BigInt serialised as a string. */
  productViews: string;
  aiCalls: number;
  aiBillableCalls: number;
  /** BigInt serialised as a string (micros of the billing currency). */
  aiCostMicros: string;
  aiUnpricedCalls: number;
}

interface UsagePeriod {
  periodStart: string;
  stores: UsageStoreRow[];
}

/** Minor units → a fixed-decimal amount in the base currency (EGP: 2 decimals). */
function formatFils(piastres: string): string {
  return formatMoney(Number(piastres), 'en', { hideSymbol: true, fixedDecimals: true });
}

function formatMonth(periodStart: string, locale: string): string {
  return new Date(`${periodStart}T00:00:00Z`).toLocaleDateString(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
    numberingSystem: 'latn', // Latin digits in both locales (issue 1971)
  });
}

function UsageHistoryInner() {
  const t = useT('usageHistory');
  const tCommon = useT('common');
  const [periods, setPeriods] = useState<UsagePeriod[] | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setError(false);
    const { data, error: apiError } = await apiGet<{ periods: UsagePeriod[] }>(
      '/api/v1/admin/super-admin/usage-history?months=12'
    );
    if (apiError || !data) {
      setError(true);
      return;
    }
    setPeriods(data.periods);
    setSelected(prev => prev ?? data.periods[0]?.periodStart ?? null);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const locale = useLocale() === 'ar' ? 'ar' : 'en-GB';
  const period = useMemo(
    () => periods?.find(p => p.periodStart === selected) ?? null,
    [periods, selected]
  );
  const rows = useMemo(
    () => [...(period?.stores ?? [])].sort((a, b) => Number(b.revenueFils) - Number(a.revenueFils)),
    [period]
  );

  if (error) {
    return (
      <div className="rounded-xl border bg-card p-6 text-center">
        <p className="text-sm text-destructive-ink">{t('loadError')}</p>
        <Button variant="link" size="sm" type="button" onClick={fetchData} className="mt-3">
          {tCommon('retry')}
        </Button>
      </div>
    );
  }

  if (!periods) {
    return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  }

  if (periods.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  }

  const columns: DataTableColumn<UsageStoreRow>[] = [
    {
      header: t('table.store'),
      primaryOnMobile: true,
      cell: r => (
        <div>
          <div className="font-medium text-foreground">{r.name}</div>
          <div className="text-xs text-muted-foreground">
            {r.slug} · {r.plan}
          </div>
        </div>
      ),
    },
    {
      header: t('table.products'),
      alignEnd: true,
      cell: r => (
        <span className="tabular-nums">
          {r.productsActive.toLocaleString(intlLocaleForUi(), withNumerals())} /{' '}
          {r.products.toLocaleString(intlLocaleForUi(), withNumerals())}
        </span>
      ),
    },
    {
      header: t('table.orders'),
      alignEnd: true,
      cell: r => (
        <span className="tabular-nums">
          {r.orders.toLocaleString(intlLocaleForUi(), withNumerals())}
        </span>
      ),
    },
    {
      header: t('table.revenue'),
      alignEnd: true,
      cell: r => <span className="tabular-nums">{formatFils(r.revenueFils)}</span>,
    },
    {
      header: t('table.customers'),
      alignEnd: true,
      hideOnMobile: true,
      cell: r => (
        <span className="tabular-nums">
          {r.customers.toLocaleString(intlLocaleForUi(), withNumerals())}
        </span>
      ),
    },
    {
      header: t('table.productViews'),
      alignEnd: true,
      hideOnMobile: true,
      cell: r => (
        <span className="tabular-nums">
          {Number(r.productViews).toLocaleString(intlLocaleForUi(), withNumerals())}
        </span>
      ),
    },
    {
      header: t('table.carts'),
      alignEnd: true,
      hideOnMobile: true,
      cell: r => (
        <span className="tabular-nums">
          {r.cartsWithItems.toLocaleString(intlLocaleForUi(), withNumerals())}
        </span>
      ),
    },
    {
      header: t('table.aiCalls'),
      alignEnd: true,
      cell: r => (
        <div className="tabular-nums">
          <div>{r.aiCalls.toLocaleString(intlLocaleForUi(), withNumerals())}</div>
          <div className="text-xs text-muted-foreground">{formatSpend(Number(r.aiCostMicros))}</div>
          {r.aiUnpricedCalls > 0 && (
            <div className="text-xs text-warning-ink">
              {t('table.aiUnpriced', {
                count: r.aiUnpricedCalls.toLocaleString(intlLocaleForUi(), withNumerals()),
              })}
            </div>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('month')}</span>
        <select
          value={selected ?? ''}
          onChange={e => setSelected(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        >
          {periods.map(p => (
            <option key={p.periodStart} value={p.periodStart}>
              {formatMonth(p.periodStart, locale)}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          {t('storeCount', { count: rows.length })}
        </span>
      </label>
      <div className="rounded-xl border bg-card shadow-sm">
        <DataTable<UsageStoreRow>
          ariaLabel={t('title')}
          columns={columns}
          rows={rows}
          rowKey={r => r.storeId}
        />
      </div>
    </div>
  );
}

export default function UsageHistoryPage() {
  const t = useT('usageHistory');
  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="super_admin">
      <RequireSuperAdmin>
        <UsageHistoryInner />
      </RequireSuperAdmin>
    </AdminLayout>
  );
}
