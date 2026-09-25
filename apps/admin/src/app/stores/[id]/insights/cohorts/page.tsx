'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';
import { filsToKwd } from '@/lib/format';
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

  const retentionColumns: DataTableColumn<string>[] = [
    {
      header: t('monthLabel'),
      primaryOnMobile: true,
      cell: month => <span className="font-mono">{month}</span>,
    },
    {
      header: t('customers'),
      cell: month => {
        const baseCell = cellMap.get(`${month}::0`);
        const total = baseCell?.customersTotal ?? 0;
        return <span className="font-mono">{total}</span>;
      },
    },
    ...offsets.map(
      (o): DataTableColumn<string> => ({
        header: (
          <>
            {t('periodLabel')} {o}
          </>
        ),
        cell: month => {
          const baseCell = cellMap.get(`${month}::0`);
          const total = baseCell?.customersTotal ?? 0;
          const cell = cellMap.get(`${month}::${o}`);
          if (!cell) {
            return <span className="text-muted-foreground/40">—</span>;
          }
          const rate = total > 0 ? cell.customersActive / total : 0;
          return (
            <span
              className={`inline-block rounded px-1.5 py-0.5 font-medium ${retentionColor(rate)}`}
              title={`${cell.customersActive} / ${total} customers active`}
            >
              {(rate * 100).toFixed(0)}%
            </span>
          );
        },
      })
    ),
  ];

  const ltvColumns: DataTableColumn<string>[] = [
    {
      header: 'Cohort',
      primaryOnMobile: true,
      cell: month => <span className="font-mono text-xs">{month}</span>,
    },
    {
      header: 'Customers',
      alignEnd: true,
      cell: month => {
        const baseCell = cellMap.get(`${month}::0`);
        const total = baseCell?.customersTotal ?? 0;
        return <span className="font-mono">{total}</span>;
      },
    },
    {
      header: 'Total Revenue (KWD)',
      alignEnd: true,
      cell: month => {
        const totalRevenue = data.cohorts
          .filter(c => c.cohortMonth === month)
          .reduce((sum, c) => sum + c.revenueInPeriod, 0);
        return <span className="font-mono">{filsToKwd(totalRevenue)}</span>;
      },
    },
    {
      header: 'LTV / Customer',
      alignEnd: true,
      cell: month => {
        const baseCell = cellMap.get(`${month}::0`);
        const total = baseCell?.customersTotal ?? 0;
        const totalRevenue = data.cohorts
          .filter(c => c.cohortMonth === month)
          .reduce((sum, c) => sum + c.revenueInPeriod, 0);
        const ltv = total > 0 ? totalRevenue / total : 0;
        return <span className="font-mono">{filsToKwd(ltv)}</span>;
      },
    },
  ];

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
              <DataTable<string>
                columns={retentionColumns}
                rows={cohortMonths}
                rowKey={month => month}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Cells show % of cohort customers who placed an order in that period. Green = high
                retention, red = low.
              </p>
            </section>

            {/* LTV data table (simple) */}
            <section>
              <h2 className="text-base font-semibold mb-3">Cumulative LTV by Cohort</h2>
              <DataTable<string> columns={ltvColumns} rows={cohortMonths} rowKey={month => month} />
            </section>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
