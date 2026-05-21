'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';

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
  conversionRate: number;
}

interface TopSegment {
  segment: string;
  count: number;
  revenueContributionFils: number;
}

interface InsightsDashboard {
  aov: { thisPeriodFils: number; lastPeriodFils: number };
  mrr30d: number;
  repeatPurchaseRate: number;
  topSegment: TopSegment | null;
  topSkus: TopSku[];
  yesterdayFunnel: YesterdayFunnel | null;
  narration?: { en: string; ar: string } | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function kwd(fils: number | null | undefined): string {
  if (typeof fils !== 'number' || !Number.isFinite(fils)) return '0.000';
  return (fils / 1000).toFixed(3);
}

function pct(val: number | null | undefined): string {
  if (typeof val !== 'number' || !Number.isFinite(val)) return '0.0%';
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
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('insights.dashboard');
  const tc = useT('common');

  const [data, setData] = useState<InsightsDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId) return;
    apiGet<InsightsDashboard>(`/api/v1/stores/${storeId}/insights/dashboard`)
      .then(({ data: d, error: apiError }) => {
        if (apiError) setError(apiError.message);
        else if (d) setData(d);
      })
      .catch(() => setError('Failed to load insights dashboard'));
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

  const aovThis = data.aov?.thisPeriodFils ?? 0;
  const aovLast = data.aov?.lastPeriodFils ?? 0;
  const aovChange = aovLast > 0 ? ((aovThis - aovLast) / aovLast) * 100 : 0;

  return (
    <AdminLayout title={t('title')}>
      <div className="max-w-5xl space-y-6">
        {/* AI narration callout */}
        {data.narration?.en && (
          <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm italic text-muted-foreground">
            <span className="not-italic font-semibold text-primary">{t('aiCallout')}</span>{' '}
            {data.narration.en}
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
            <p className="text-2xl font-semibold font-mono">{kwd(aovThis)}</p>
            <p className="text-xs text-muted-foreground">
              KWD
              {aovChange !== 0 && (
                <span
                  className={`ms-2 font-medium ${aovChange >= 0 ? 'text-green-700' : 'text-red-600'}`}
                >
                  {aovChange >= 0 ? '+' : ''}
                  {num(aovChange, 1)}%
                </span>
              )}
            </p>
          </div>

          {/* MRR / 30d revenue */}
          <div className="rounded-xl border border-border p-4 space-y-1">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('mrr30d')}</p>
            <p className="text-2xl font-semibold font-mono text-green-700">{kwd(data.mrr30d)}</p>
            <p className="text-xs text-muted-foreground">KWD</p>
          </div>

          {/* Repeat purchase rate */}
          <div className="rounded-xl border border-border p-4 space-y-1">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">
              {t('repeatPurchase')}
            </p>
            <p className="text-2xl font-semibold font-mono">{pct(data.repeatPurchaseRate)}</p>
            <p className="text-xs text-muted-foreground">of customers re-ordered</p>
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
                  {data.topSegment.count} customers · {kwd(data.topSegment.revenueContributionFils)}{' '}
                  KWD
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
                { label: 'Carts', value: data.yesterdayFunnel.cartsCreated },
                { label: 'Checkouts', value: data.yesterdayFunnel.checkoutsStarted },
                { label: 'Completed', value: data.yesterdayFunnel.ordersCompleted },
                {
                  label: 'Conversion',
                  value: pct(data.yesterdayFunnel.conversionRate),
                  highlight: true,
                },
              ].map(step => (
                <div key={step.label} className="rounded-lg border border-border p-3 space-y-0.5">
                  <p className="text-xs text-muted-foreground">{step.label}</p>
                  <p
                    className={`text-xl font-semibold font-mono ${step.highlight ? 'text-primary' : ''}`}
                  >
                    {step.value}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Top 5 SKUs */}
        {data.topSkus.length > 0 && (
          <section>
            <h2 className="text-base font-semibold mb-3">{t('topSkus')}</h2>
            <div className="rounded-xl border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 bg-muted/40">
                    <th className="px-3 py-2 text-start text-xs font-medium text-muted-foreground">
                      SKU
                    </th>
                    <th className="px-3 py-2 text-start text-xs font-medium text-muted-foreground">
                      Name
                    </th>
                    <th className="px-3 py-2 text-end text-xs font-medium text-muted-foreground">
                      Sold 7d
                    </th>
                    <th className="px-3 py-2 text-end text-xs font-medium text-muted-foreground">
                      Velocity
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.topSkus.map((sku, i) => (
                    <tr key={sku.productId} className="border-b border-border/40 last:border-0">
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                        {sku.sku ?? `#${i + 1}`}
                      </td>
                      <td className="px-3 py-2">{sku.name}</td>
                      <td className="px-3 py-2 text-end font-mono">{sku.unitsSold7d}</td>
                      <td className="px-3 py-2 text-end font-mono text-xs text-muted-foreground">
                        {num(sku.velocity, 2)}/day
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </AdminLayout>
  );
}
