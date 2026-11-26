'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { AdminLayout } from '@/components/AdminLayout';
import { PageState } from '@/components/PageState';
import { useT } from '@/i18n/useT';
import { pickNarration } from '@/i18n/narration';
import { apiGet } from '@/lib/api';
import { minorToMajor } from '@/lib/format';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';

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
  if (rate >= 0.7) return 'bg-success/20 text-success-ink';
  if (rate >= 0.5) return 'bg-success/10 text-success-ink';
  if (rate >= 0.3) return 'bg-warning/10 text-warning-ink';
  if (rate >= 0.1) return 'bg-destructive/10 text-destructive-ink';
  return 'bg-destructive/10 text-destructive-ink';
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function InsightsCohortsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('insights.cohorts');
  const locale = useLocale();

  const [data, setData] = useState<CohortData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!storeId) return;
    apiGet<CohortData>(`/api/v1/stores/${storeId}/insights/cohorts`)
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

  // Locale-aware AI narration body (#1933) — see segments/page.tsx.
  const narration = pickNarration(data.narration, locale);

  const ltvColumns: DataTableColumn<string>[] = [
    {
      header: t('monthLabel'),
      primaryOnMobile: true,
      cell: month => <span className="font-mono text-xs">{month}</span>,
    },
    {
      header: t('customers'),
      alignEnd: true,
      cell: month => {
        const baseCell = cellMap.get(`${month}::0`);
        const total = baseCell?.customersTotal ?? 0;
        return <span className="font-mono">{total}</span>;
      },
    },
    {
      header: t('colTotalRevenue'),
      alignEnd: true,
      cell: month => {
        const totalRevenue = data.cohorts
          .filter(c => c.cohortMonth === month)
          .reduce((sum, c) => sum + c.revenueInPeriod, 0);
        return <span className="font-mono">{minorToMajor(totalRevenue)}</span>;
      },
    },
    {
      header: t('colLtvPerCustomer'),
      alignEnd: true,
      cell: month => {
        const baseCell = cellMap.get(`${month}::0`);
        const total = baseCell?.customersTotal ?? 0;
        const totalRevenue = data.cohorts
          .filter(c => c.cohortMonth === month)
          .reduce((sum, c) => sum + c.revenueInPeriod, 0);
        const ltv = total > 0 ? totalRevenue / total : 0;
        return <span className="font-mono">{minorToMajor(ltv)}</span>;
      },
    },
  ];

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="max-w-5xl space-y-6">
        {/* AI narration callout */}
        {narration && (
          <div className="rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm italic text-muted-foreground">
            <span className="not-italic font-semibold text-primary">{t('aiLabel')}</span>{' '}
            {narration}
          </div>
        )}

        {cohortMonths.length === 0 ? (
          <div className="rounded-md border border-border px-4 py-3 text-sm text-muted-foreground">
            {t('noDataYet')}
          </div>
        ) : (
          <>
            {/* Retention matrix — genuine grid (rows are cohort months,
                columns are period offsets; the cross-cohort COMPARISON is
                the point). Card-stacking this through DataTable (#1966) lost
                exactly that: one card per cohort with 13+ stacked label
                rows instead of a scannable matrix, and the sticky month
                column that keeps a percentage attached to its row while
                scrolling sideways. Kept as an isolated horizontal-scroll
                `<table>` per the same B1 exception journal/bank-
                reconciliation use, with the first column pinned. */}
            <section>
              <h2 className="text-base font-semibold mb-3">{t('retentionMatrixTitle')}</h2>
              <div className="rounded-md border border-border overflow-x-auto">
                <table className="min-w-max text-sm">
                  <thead className="bg-muted/30">
                    <tr>
                      <th className="sticky start-0 z-10 bg-muted/30 text-start px-3 py-2 font-medium text-muted-foreground">
                        {t('monthLabel')}
                      </th>
                      <th className="text-end px-3 py-2 font-medium text-muted-foreground">
                        {t('customers')}
                      </th>
                      {offsets.map(o => (
                        <th
                          key={o}
                          className="whitespace-nowrap text-end px-3 py-2 font-medium text-muted-foreground"
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
                        <tr key={month} className="border-t border-border/40">
                          <td className="sticky start-0 z-10 bg-card font-mono px-3 py-2">
                            {month}
                          </td>
                          <td className="text-end px-3 py-2 font-mono">{total}</td>
                          {offsets.map(o => {
                            const cell = cellMap.get(`${month}::${o}`);
                            if (!cell) {
                              return (
                                <td key={o} className="text-end px-3 py-2 text-muted-foreground/40">
                                  —
                                </td>
                              );
                            }
                            const rate = total > 0 ? cell.customersActive / total : 0;
                            return (
                              <td key={o} className="text-end px-3 py-2">
                                <span
                                  className={`inline-block rounded-md px-1.5 py-0.5 font-medium ${retentionColor(rate)}`}
                                  title={t('cellTitle', { active: cell.customersActive, total })}
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
              <p className="mt-2 text-xs text-muted-foreground">{t('legendNote')}</p>
            </section>

            {/* LTV data table (simple) */}
            <section>
              <h2 className="text-base font-semibold mb-3">{t('ltvByCohortTitle')}</h2>
              <DataTable<string>
                ariaLabel={t('ltvByCohortTitle')}
                columns={ltvColumns}
                rows={cohortMonths}
                rowKey={month => month}
              />
            </section>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
