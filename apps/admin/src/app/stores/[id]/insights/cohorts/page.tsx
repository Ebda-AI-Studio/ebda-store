'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';
import { filsToKwd } from '@/lib/format';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CohortCell {
  cohortMonth: string;
  periodOffset: number;
  customersTotal: number;
  customersActive: number;
  ordersInPeriod: number;
  revenueInPeriod: number;
}

interface CohortData {
  cohorts: CohortCell[];
  narration?: { en: string; ar: string } | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns a Tailwind bg class based on retention 0..1 */
function retentionColor(rate: number): string {
  if (rate >= 0.7) return 'bg-green-200 text-green-900';
  if (rate >= 0.5) return 'bg-green-100 text-green-800';
  if (rate >= 0.3) return 'bg-amber-100 text-amber-800';
  if (rate >= 0.1) return 'bg-red-100 text-red-700';
  return 'bg-red-50 text-red-500';
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function InsightsCohortsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('insights.cohorts');

  const [data, setData] = useState<CohortData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId) return;
    apiGet<CohortData>(`/api/v1/stores/${storeId}/insights/cohorts`)
      .then(({ data: d, error: apiError }) => {
        if (apiError) setError(apiError.message);
        else if (d) setData(d);
      })
      .catch(() => setError('Failed to load cohort data'));
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
        <div className="flex items-center justify-center h-64">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </AdminLayout>
    );
  }

  // Build matrix: rows = unique cohortMonths (newest first), cols = unique offsets
  const cohortMonths = Array.from(new Set(data.cohorts.map(c => c.cohortMonth))).sort((a, b) =>
    b.localeCompare(a)
  );
  const maxOffset = data.cohorts.reduce((m, c) => Math.max(m, c.periodOffset), 0);
  const offsets = Array.from({ length: maxOffset + 1 }, (_, i) => i);

  // Build lookup map
  const cellMap = new Map<string, CohortCell>();
  for (const c of data.cohorts) {
    cellMap.set(`${c.cohortMonth}::${c.periodOffset}`, c);
  }

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="max-w-5xl space-y-6">
        {/* AI narration callout */}
        {data.narration?.en && (
          <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm italic text-muted-foreground">
            <span className="not-italic font-semibold text-primary">AI:</span> {data.narration.en}
          </div>
        )}

        {cohortMonths.length === 0 ? (
          <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
            No cohort data yet. Insights will populate after the first nightly rollup at 02:00 KW.
          </div>
        ) : (
          <>
            {/* Retention matrix */}
            <section>
              <h2 className="text-base font-semibold mb-3">Retention Matrix</h2>
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="text-xs min-w-max">
                  <thead>
                    <tr className="border-b border-border/60 bg-muted/40">
                      <th className="px-3 py-2 text-start font-medium text-muted-foreground sticky left-0 bg-muted/40">
                        {t('monthLabel')}
                      </th>
                      <th className="px-3 py-2 text-center font-medium text-muted-foreground">
                        {t('customers')}
                      </th>
                      {offsets.map(o => (
                        <th
                          key={o}
                          className="px-2 py-2 text-center font-medium text-muted-foreground"
                        >
                          {t('periodLabel')} {o}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cohortMonths.map(month => {
                      const baseCell = cellMap.get(`${month}::0`);
                      const total = baseCell?.customersTotal ?? 0;
                      return (
                        <tr key={month} className="border-b border-border/40 last:border-0">
                          <td className="px-3 py-2 font-mono sticky left-0 bg-background">
                            {month}
                          </td>
                          <td className="px-3 py-2 text-center font-mono">{total}</td>
                          {offsets.map(o => {
                            const cell = cellMap.get(`${month}::${o}`);
                            if (!cell) {
                              return (
                                <td
                                  key={o}
                                  className="px-2 py-2 text-center text-muted-foreground/40"
                                >
                                  —
                                </td>
                              );
                            }
                            const rate = total > 0 ? cell.customersActive / total : 0;
                            return (
                              <td key={o} className="px-2 py-2 text-center">
                                <span
                                  className={`inline-block rounded px-1.5 py-0.5 font-medium ${retentionColor(
                                    rate
                                  )}`}
                                  title={`${cell.customersActive} / ${total} customers active`}
                                >
                                  {(rate * 100).toFixed(0)}%
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Cells show % of cohort customers who placed an order in that period. Green = high
                retention, red = low.
              </p>
            </section>

            {/* LTV data table (simple) */}
            <section>
              <h2 className="text-base font-semibold mb-3">Cumulative LTV by Cohort</h2>
              <div className="rounded-xl border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/60 bg-muted/40">
                      <th className="px-3 py-2 text-start text-xs font-medium text-muted-foreground">
                        Cohort
                      </th>
                      <th className="px-3 py-2 text-end text-xs font-medium text-muted-foreground">
                        Customers
                      </th>
                      <th className="px-3 py-2 text-end text-xs font-medium text-muted-foreground">
                        Total Revenue (KWD)
                      </th>
                      <th className="px-3 py-2 text-end text-xs font-medium text-muted-foreground">
                        LTV / Customer
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {cohortMonths.map(month => {
                      const baseCell = cellMap.get(`${month}::0`);
                      const total = baseCell?.customersTotal ?? 0;
                      // Sum revenue across all offsets
                      const totalRevenue = data.cohorts
                        .filter(c => c.cohortMonth === month)
                        .reduce((sum, c) => sum + c.revenueInPeriod, 0);
                      const ltv = total > 0 ? totalRevenue / total : 0;
                      return (
                        <tr key={month} className="border-b border-border/40 last:border-0">
                          <td className="px-3 py-2 font-mono text-xs">{month}</td>
                          <td className="px-3 py-2 text-end font-mono">{total}</td>
                          <td className="px-3 py-2 text-end font-mono">
                            {filsToKwd(totalRevenue)}
                          </td>
                          <td className="px-3 py-2 text-end font-mono">{filsToKwd(ltv)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
