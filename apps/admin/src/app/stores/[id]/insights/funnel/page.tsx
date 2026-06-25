'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';
import { filsToKwd } from '@/lib/format';

// ─── Types ────────────────────────────────────────────────────────────────────

type Window = '7' | '30' | '90';

interface FunnelDay {
  periodDate: string;
  productViews: number;
  cartsCreated: number;
  cartItemsAdded: number;
  checkoutsStarted: number;
  ordersCompleted: number;
  ordersAbandoned: number;
  revenueFils: number;
}

interface FunnelData {
  days: FunnelDay[];
  narration?: { en: string; ar: string } | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function dropoff(from: number, to: number): string {
  if (from === 0) return '—';
  const pct = ((from - to) / from) * 100;
  return `-${pct.toFixed(1)}%`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function InsightsFunnelPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('insights.funnel');
  const tc = useT('common');

  const [window, setWindow] = useState<Window>('30');
  const [data, setData] = useState<FunnelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchData = useCallback(
    (w: Window) => {
      if (!storeId) return;
      setLoading(true);
      setError(null);
      apiGet<FunnelData>(`/api/v1/stores/${storeId}/insights/funnel?window=${w}`)
        .then(({ data: d, error: apiError }) => {
          if (apiError) setError(apiError.message);
          else if (d) setData(d);
        })
        .catch(() => setError('Failed to load funnel data'))
        .finally(() => setLoading(false));
    },
    [storeId]
  );

  useEffect(() => {
    fetchData(window);
  }, [fetchData, window]);

  // Aggregate totals across selected window
  const totals = data?.days.reduce(
    (acc, d) => ({
      productViews: acc.productViews + d.productViews,
      cartsCreated: acc.cartsCreated + d.cartsCreated,
      checkoutsStarted: acc.checkoutsStarted + d.checkoutsStarted,
      ordersCompleted: acc.ordersCompleted + d.ordersCompleted,
      ordersAbandoned: acc.ordersAbandoned + d.ordersAbandoned,
      revenueFils: acc.revenueFils + d.revenueFils,
    }),
    {
      productViews: 0,
      cartsCreated: 0,
      checkoutsStarted: 0,
      ordersCompleted: 0,
      ordersAbandoned: 0,
      revenueFils: 0,
    }
  );

  const steps = totals
    ? [
        { label: t('views'), value: totals.productViews || 0, note: t('viewsNote') },
        { label: t('carts'), value: totals.cartsCreated },
        { label: t('checkouts'), value: totals.checkoutsStarted },
        { label: t('completed'), value: totals.ordersCompleted },
      ]
    : [];

  const maxStep = steps.reduce((m, s) => Math.max(m, s.value), 1) || 1;

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="max-w-4xl space-y-6">
        {/* AI narration callout */}
        {data?.narration?.en && (
          <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm italic text-muted-foreground">
            <span className="not-italic font-semibold text-primary">AI:</span> {data.narration.en}
          </div>
        )}

        {/* Window picker */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('windowLabel')}:</span>
          {(['7', '30', '90'] as Window[]).map(w => (
            <button
              key={w}
              type="button"
              onClick={() => setWindow(w)}
              className={`px-3 py-1 rounded-lg text-sm border transition-colors ${
                window === w
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              {t(`window${w}d` as 'window7d' | 'window30d' | 'window90d')}
            </button>
          ))}
        </div>

        {loading && <div className="text-sm text-muted-foreground">{tc('loading')}</div>}

        {error && <div className="text-sm text-red-600">{error}</div>}

        {!loading && data && steps.length > 0 && (
          <>
            {/* Funnel bars */}
            <section>
              <h2 className="text-base font-semibold mb-3">Funnel Overview</h2>
              <div className="space-y-3">
                {steps.map((step, i) => {
                  const prevValue = i > 0 ? steps[i - 1].value : null;
                  const barWidth = maxStep > 0 ? (step.value / maxStep) * 100 : 0;
                  return (
                    <div key={step.label}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium">
                          {step.label}
                          {step.note && (
                            <span className="ms-2 text-xs text-muted-foreground">
                              ({step.note})
                            </span>
                          )}
                        </span>
                        <div className="flex items-center gap-3">
                          {prevValue !== null && (
                            <span className="text-xs text-red-500">
                              {dropoff(prevValue, step.value)}
                            </span>
                          )}
                          <span className="font-mono font-semibold">
                            {step.value.toLocaleString()}
                          </span>
                        </div>
                      </div>
                      <div className="h-8 rounded-md bg-muted overflow-hidden">
                        <div
                          className="h-full bg-primary/70 rounded-md transition-all duration-500"
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Revenue + abandoned summary */}
            {totals && (
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-xl border border-border p-4 space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">
                    {t('revenue')}
                  </p>
                  <p className="text-2xl font-semibold font-mono text-green-700">
                    {filsToKwd(totals.revenueFils)}
                  </p>
                  <p className="text-xs text-muted-foreground">KWD</p>
                </div>
                <div className="rounded-xl border border-border p-4 space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">
                    {t('abandoned')}
                  </p>
                  <p className="text-2xl font-semibold font-mono text-amber-600">
                    {totals.ordersAbandoned}
                  </p>
                  <p className="text-xs text-muted-foreground">carts</p>
                </div>
              </div>
            )}

            {/* Daily trend table */}
            <section>
              <h2 className="text-base font-semibold mb-3">Daily Breakdown</h2>
              <div className="rounded-xl border border-border overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-max">
                    <thead>
                      <tr className="border-b border-border/60 bg-muted/40">
                        <th className="px-3 py-2 text-start text-xs font-medium text-muted-foreground">
                          Date
                        </th>
                        <th className="px-3 py-2 text-end text-xs font-medium text-muted-foreground">
                          {t('carts')}
                        </th>
                        <th className="px-3 py-2 text-end text-xs font-medium text-muted-foreground">
                          {t('checkouts')}
                        </th>
                        <th className="px-3 py-2 text-end text-xs font-medium text-muted-foreground">
                          {t('completed')}
                        </th>
                        <th className="px-3 py-2 text-end text-xs font-medium text-muted-foreground">
                          {t('revenue')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...data.days]
                        .sort(
                          (a, b) =>
                            new Date(b.periodDate).getTime() - new Date(a.periodDate).getTime()
                        )
                        .map(day => (
                          <tr
                            key={day.periodDate}
                            className="border-b border-border/40 last:border-0"
                          >
                            <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                              {day.periodDate.slice(0, 10)}
                            </td>
                            <td className="px-3 py-2 text-end font-mono">{day.cartsCreated}</td>
                            <td className="px-3 py-2 text-end font-mono">{day.checkoutsStarted}</td>
                            <td className="px-3 py-2 text-end font-mono">{day.ordersCompleted}</td>
                            <td className="px-3 py-2 text-end font-mono">
                              {filsToKwd(day.revenueFils)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          </>
        )}

        {!loading && data?.days.length === 0 && (
          <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
            No funnel data yet for this window. Insights populate after the first nightly rollup at
            02:00 KW.
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
