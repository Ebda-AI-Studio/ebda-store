'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { AdminLayout } from '@/components/AdminLayout';
import { PageState } from '@/components/PageState';
import { useT } from '@/i18n/useT';
import { pickNarration } from '@/i18n/narration';
import { apiGet } from '@/lib/api';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { isUntrackedForGuests } from '@/lib/guest-checkout';

import { minorToDecimalString, withNumerals } from '@ebda/shared';
import { SignedNumber } from '@ebda/ui';
// ─── Types ────────────────────────────────────────────────────────────────────

interface TopSku {
  productId: string;
  name: string;
  nameAr: string | null;
  sku: string | null;
  unitsSold7d: number;
  velocity: number;
}

interface YesterdayFunnel {
  cartsCreated: number;
  checkoutsStarted: number;
  ordersCompleted: number;
  /**
   * ordersCompleted / cartsCreated; null when no cart was created (unknown).
   * Cart→order — not the /analytics `conversionRate` (orders per product view).
   */
  cartToOrderRate: number | null;
}

interface TopSegment {
  segment: string;
  count: number;
  revenueContributionFils: number;
}

interface InsightsDashboard {
  aov: { thisPeriodFils: number; lastPeriodFils: number };
  mrr30d: number;
  /** Fraction 0..1 over identifiable buyers (customer or guest contact); null = unknown. */
  repeatPurchaseRate: number | null;
  repeatPurchaseBuyers?: number;
  topSegment: TopSegment | null;
  topSkus: TopSku[];
  /** Store took guest orders in the last 30d — funnel checkouts miss guest carts. */
  guestCheckout?: boolean;
  yesterdayFunnel: YesterdayFunnel | null;
  // ISO date of the snapshot powering the velocity panel. Mirrors the
  // computedAt/snapshot date shown on the segments / cohorts / funnel panels.
  velocityAsOf?: string | null;
  narration?: { en: string; ar: string } | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function major(piastres: number | null | undefined): string {
  if (typeof piastres !== 'number' || !Number.isFinite(piastres)) return '0.00';
  return minorToDecimalString(piastres);
}

// Unknown (null) renders as "—", never as a false 0.0%.
function pct(val: number | null | undefined): string {
  if (typeof val !== 'number' || !Number.isFinite(val)) return '—';
  return (val * 100).toFixed(1) + '%';
}

// 2026-05-21: number formatter helper for table cells. `sku.velocity` and
// similar numeric API fields can be null when an SKU has no rollup data
// yet (new product, no orders in window) — crashing the whole page with
// "Cannot read properties of undefined" is wrong. Default to 0 + the
// `digits` decimal places. Used wherever an API number could be missing.
function num(v: number | null | undefined, digits = 2): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return (0).toFixed(digits);
  return v.toFixed(digits);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function InsightsDashboardPage() {
  const tc = useT('common');
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('insights.dashboard');
  const tFunnel = useT('insights.funnel');
  const tGuest = useT('components.guestCheckout');
  const locale = useLocale();

  const [data, setData] = useState<InsightsDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!storeId) return;
    apiGet<InsightsDashboard>(`/api/v1/stores/${storeId}/insights/dashboard`)
      .then(({ data: d, error: apiError }) => {
        if (apiError) setError(apiError.message);
        else if (d) setData(d);
      })
      .catch(() => setError(t('loadFailed')));
  }, [storeId, reloadKey]);

  if (error || !data) {
    return (
      <AdminLayout title={t('title')}>
        <PageState
          loading={!error}
          error={error}
          onRetry={() => {
            setError(null);
            setReloadKey(k => k + 1);
          }}
        >
          {null}
        </PageState>
      </AdminLayout>
    );
  }

  const aovThis = data.aov?.thisPeriodFils ?? 0;
  const aovLast = data.aov?.lastPeriodFils ?? 0;
  const aovChange = aovLast > 0 ? ((aovThis - aovLast) / aovLast) * 100 : 0;

  // Locale-aware AI narration body (#1933) — see segments/page.tsx.
  const narration = pickNarration(data.narration, locale);

  const topSkusColumns: DataTableColumn<TopSku>[] = [
    {
      header: t('colSku'),
      cell: (sku, i) => (
        <span className="font-mono text-xs text-muted-foreground">{sku.sku ?? `#${i + 1}`}</span>
      ),
    },
    {
      header: t('colName'),
      primaryOnMobile: true,
      cell: sku => sku.name,
    },
    {
      header: t('colSold7d'),
      alignEnd: true,
      cell: sku => <span className="font-mono">{sku.unitsSold7d}</span>,
    },
    {
      header: t('colVelocity'),
      alignEnd: true,
      cell: sku => (
        <span className="font-mono text-xs text-muted-foreground">
          {num(sku.velocity, 2)}
          {t('perDay')}
        </span>
      ),
    },
  ];

  return (
    <AdminLayout title={t('title')}>
      <div className="max-w-5xl space-y-6">
        {/* AI narration callout */}
        {narration && (
          <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm italic text-muted-foreground">
            <span className="not-italic font-semibold text-primary">{t('aiCallout')}</span>{' '}
            {narration}
          </div>
        )}

        {/* No data notice */}
        {!data.yesterdayFunnel && data.topSkus.length === 0 && (
          <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
            {t('noDataYet')}
          </div>
        )}

        {/* KPI tiles */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* AOV */}
          <div className="rounded-xl border border-border p-4 space-y-1">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('aov')}</p>
            <p className="text-2xl font-semibold font-mono">{major(aovThis)}</p>
            <p className="text-xs text-muted-foreground">
              {tc('egp')}
              {aovChange !== 0 && (
                <span
                  className={`ms-2 font-medium ${
                    aovChange >= 0 ? 'text-green-700' : 'text-red-600'
                  }`}
                >
                  <SignedNumber
                    value={aovChange}
                    plus
                    fractionDigits={1}
                    format={abs => `${num(abs, 1)}%`}
                  />
                </span>
              )}
            </p>
          </div>

          {/* MRR / 30d revenue */}
          <div className="rounded-xl border border-border p-4 space-y-1">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('mrr30d')}</p>
            <p className="text-2xl font-semibold font-mono text-green-700">{major(data.mrr30d)}</p>
            <p className="text-xs text-muted-foreground">{tc('egp')}</p>
          </div>

          {/* Repeat purchase rate */}
          <div className="rounded-xl border border-border p-4 space-y-1">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">
              {t('repeatPurchase')}
            </p>
            <p className="text-2xl font-semibold font-mono">{pct(data.repeatPurchaseRate)}</p>
            <p className="text-xs text-muted-foreground">
              {data.repeatPurchaseRate === null
                ? t('repeatPurchaseUnknown')
                : t('repeatPurchaseBasis', { count: data.repeatPurchaseBuyers ?? 0 })}
            </p>
          </div>

          {/* Top segment */}
          <div className="rounded-xl border border-border p-4 space-y-1">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">
              {t('topSegment')}
            </p>
            {data.topSegment ? (
              <>
                <p className="text-xl font-semibold capitalize">
                  {data.topSegment.segment.replace(/_/g, ' ')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('topSegmentCustomers', { count: data.topSegment.count })} ·{' '}
                  {major(data.topSegment.revenueContributionFils)} {tc('egp')}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">—</p>
            )}
          </div>
        </div>

        {/* Yesterday's funnel */}
        {data.yesterdayFunnel && (
          <section>
            <h2 className="text-base font-semibold mb-3">{t('yesterdayFunnel')}</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: tFunnel('carts'), value: data.yesterdayFunnel.cartsCreated },
                {
                  label: tFunnel('checkouts'),
                  // abandoned_carts cannot see guest carts: 0 here on a
                  // guest-checkout store is "not tracked", not 0.
                  value: isUntrackedForGuests(
                    data.yesterdayFunnel.checkoutsStarted,
                    data.guestCheckout
                  )
                    ? null
                    : data.yesterdayFunnel.checkoutsStarted,
                },
                { label: tFunnel('completed'), value: data.yesterdayFunnel.ordersCompleted },
                {
                  label: t('cartToOrder'),
                  value: pct(data.yesterdayFunnel.cartToOrderRate),
                  highlight: true,
                },
              ].map(step => (
                <div key={step.label} className="rounded-lg border border-border p-3 space-y-0.5">
                  <p className="text-xs text-muted-foreground">{step.label}</p>
                  {step.value === null ? (
                    <p className="text-xs font-medium text-muted-foreground pt-1">
                      {tGuest('notTracked')}
                    </p>
                  ) : (
                    <p
                      className={`text-xl font-semibold font-mono ${
                        step.highlight ? 'text-primary' : ''
                      }`}
                    >
                      {step.value}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Top 5 SKUs */}
        {data.topSkus.length > 0 && (
          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">{t('topSkus')}</h2>
              {/* Last-updated date+time — matches the segments / cohorts /
                  funnel insights panels. */}
              {data.velocityAsOf && (
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {t('asOf')}:{' '}
                  {new Date(data.velocityAsOf).toLocaleString(undefined, withNumerals())}
                </span>
              )}
            </div>
            <DataTable<TopSku>
              ariaLabel={t('topSkus')}
              columns={topSkusColumns}
              rows={data.topSkus}
              rowKey={sku => sku.productId}
            />
          </section>
        )}
      </div>
    </AdminLayout>
  );
}
