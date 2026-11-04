'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { AdminLayout } from '@/components/AdminLayout';
import { ErrorState } from '@/components/ErrorState';
import { AdminSkeletonPage } from '@/components/AdminSkeleton';
import { useT } from '@/i18n/useT';
import { pickNarration } from '@/i18n/narration';
import { apiGet } from '@/lib/api';
import { minorToMajor } from '@/lib/format';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { isUntrackedForGuests } from '@/lib/guest-checkout';
import { withNumerals } from '@ebda/shared';

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
  /** Store takes guest orders: checkouts/abandoned (from abandoned_carts) miss guest carts. */
  guestCheckout?: boolean;
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
  const tGuest = useT('components.guestCheckout');
  const tc = useT('common');
  const locale = useLocale();

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
        .catch(() => setError(t('loadFailed')))
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

  const guestCheckout = data?.guestCheckout === true;
  // "Checkouts started" comes from abandoned_carts, which cannot see guest
  // carts: on a guest-checkout store a 0 there is "not tracked", not 0.
  const checkoutsUntracked = totals
    ? isUntrackedForGuests(totals.checkoutsStarted, guestCheckout)
    : false;
  const abandonedUntracked = totals
    ? isUntrackedForGuests(totals.ordersAbandoned, guestCheckout)
    : false;

  // value null = not tracked; the next step's drop-off is measured from the
  // last step that WAS tracked.
  const steps: Array<{ label: string; value: number | null }> = totals
    ? [
        { label: t('views'), value: totals.productViews || 0 },
        { label: t('carts'), value: totals.cartsCreated },
        { label: t('checkouts'), value: checkoutsUntracked ? null : totals.checkoutsStarted },
        { label: t('completed'), value: totals.ordersCompleted },
      ]
    : [];

  const maxStep = steps.reduce((m, s) => Math.max(m, s.value ?? 0), 1) || 1;

  // Locale-aware AI narration body (#1933) — see segments/page.tsx.
  const narration = pickNarration(data?.narration, locale);

  const sortedDays = data
    ? [...data.days].sort(
        (a, b) => new Date(b.periodDate).getTime() - new Date(a.periodDate).getTime()
      )
    : [];

  const dailyColumns: DataTableColumn<FunnelDay>[] = [
    {
      header: t('colDate'),
      primaryOnMobile: true,
      cell: day => (
        <span className="font-mono text-xs text-muted-foreground">
          {day.periodDate.slice(0, 10)}
        </span>
      ),
    },
    {
      header: t('carts'),
      alignEnd: true,
      cell: day => <span className="font-mono">{day.cartsCreated}</span>,
    },
    {
      header: t('checkouts'),
      alignEnd: true,
      cell: day => {
        const untracked = isUntrackedForGuests(day.checkoutsStarted, guestCheckout);
        return untracked ? (
          <span className="font-mono text-muted-foreground" title={tGuest('notTracked')}>
            —
          </span>
        ) : (
          <span className="font-mono">{day.checkoutsStarted}</span>
        );
      },
    },
    {
      header: t('completed'),
      alignEnd: true,
      cell: day => <span className="font-mono">{day.ordersCompleted}</span>,
    },
    {
      header: t('revenue'),
      alignEnd: true,
      cell: day => <span className="font-mono">{minorToMajor(day.revenueFils)}</span>,
    },
  ];

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="max-w-4xl space-y-6">
        {/* AI narration callout */}
        {narration && (
          <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm italic text-muted-foreground">
            <span className="not-italic font-semibold text-primary">{t('aiLabel')}</span>{' '}
            {narration}
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

        {loading && <AdminSkeletonPage variants={['cards', 'table']} />}

        {error && <ErrorState message={error} onRetry={() => fetchData(window)} />}

        {!loading && data && steps.length > 0 && (
          <>
            {/* Funnel bars */}
            <section>
              <h2 className="text-base font-semibold mb-3">{t('overviewTitle')}</h2>
              <div className="space-y-3">
                {steps.map((step, i) => {
                  const prevValue =
                    steps
                      .slice(0, i)
                      .reverse()
                      .find(s => s.value !== null)?.value ?? null;
                  const barWidth =
                    step.value !== null && maxStep > 0 ? (step.value / maxStep) * 100 : 0;
                  return (
                    <div key={step.label}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium">{step.label}</span>
                        <div className="flex items-center gap-3">
                          {prevValue !== null && step.value !== null && (
                            <span className="text-xs text-red-500">
                              {dropoff(prevValue, step.value)}
                            </span>
                          )}
                          {step.value === null ? (
                            <span className="text-xs text-muted-foreground">
                              {tGuest('notTracked')}
                            </span>
                          ) : (
                            <span className="font-mono font-semibold">
                              {step.value.toLocaleString(undefined, withNumerals())}
                            </span>
                          )}
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
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-border p-4 space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">
                    {t('revenue')}
                  </p>
                  <p className="text-2xl font-semibold font-mono text-green-700">
                    {minorToMajor(totals.revenueFils)}
                  </p>
                  <p className="text-xs text-muted-foreground">{tc('egp')}</p>
                </div>
                <div className="rounded-xl border border-border p-4 space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">
                    {t('abandoned')}
                  </p>
                  {abandonedUntracked ? (
                    <p className="text-sm font-medium text-muted-foreground">
                      {tGuest('notTracked')}
                    </p>
                  ) : (
                    <>
                      <p className="text-2xl font-semibold font-mono text-warning-ink">
                        {totals.ordersAbandoned}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('abandonedUnit')}
                        {guestCheckout && ` · ${tGuest('registeredOnly')}`}
                      </p>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Daily trend table */}
            <section>
              <h2 className="text-base font-semibold mb-3">{t('dailyBreakdownTitle')}</h2>
              {checkoutsUntracked && (
                <p className="mb-2 text-xs text-muted-foreground">{tGuest('checkoutsTableNote')}</p>
              )}
              <DataTable<FunnelDay>
                ariaLabel={t('dailyBreakdownTitle')}
                columns={dailyColumns}
                rows={sortedDays}
                rowKey={day => day.periodDate}
              />
            </section>
          </>
        )}

        {!loading && !error && data?.days.length === 0 && (
          <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
            {t('noDataYet')}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
