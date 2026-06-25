'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';
import { filsToKwd } from '@/lib/format';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RfmSegmentRow {
  segment: string;
  count: number;
  totalMonetaryFils: number;
  recommendedAction: string | null;
}

interface SegmentsData {
  segments: RfmSegmentRow[];
  narration?: { en: string; ar: string } | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SEGMENT_COLORS: Record<string, string> = {
  vip: 'bg-purple-100 text-purple-900 border-purple-200',
  loyal: 'bg-blue-100 text-blue-900 border-blue-200',
  potential: 'bg-cyan-100 text-cyan-900 border-cyan-200',
  new_customer: 'bg-green-100 text-green-900 border-green-200',
  at_risk: 'bg-amber-100 text-amber-900 border-amber-200',
  hibernating: 'bg-orange-100 text-orange-900 border-orange-200',
  lost: 'bg-red-100 text-red-900 border-red-200',
};

const SEGMENT_ICONS: Record<string, string> = {
  vip: '★',
  loyal: '♦',
  potential: '◆',
  new_customer: '✦',
  at_risk: '⚠',
  hibernating: '☽',
  lost: '✕',
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function InsightsSegmentsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('insights.segments');

  const [data, setData] = useState<SegmentsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId) return;
    apiGet<SegmentsData>(`/api/v1/stores/${storeId}/insights/segments`)
      .then(({ data: d, error: apiError }) => {
        if (apiError) setError(apiError.message);
        else if (d) setData(d);
      })
      .catch(() => setError('Failed to load segments data'));
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

  const totalCustomers = data.segments.reduce((sum, s) => sum + s.count, 0);
  const totalRevenue = data.segments.reduce((sum, s) => sum + s.totalMonetaryFils, 0);

  // Sort by count descending
  const sorted = [...data.segments].sort((a, b) => b.count - a.count);

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="max-w-5xl space-y-6">
        {/* AI narration callout */}
        {data.narration?.en && (
          <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm italic text-muted-foreground">
            <span className="not-italic font-semibold text-primary">AI:</span> {data.narration.en}
          </div>
        )}

        {/* Summary */}
        {totalCustomers > 0 && (
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-xl border border-border p-4 space-y-1">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                Total Segmented Customers
              </p>
              <p className="text-2xl font-semibold font-mono">{totalCustomers}</p>
            </div>
            <div className="rounded-xl border border-border p-4 space-y-1">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                Total Monetary Value
              </p>
              <p className="text-2xl font-semibold font-mono text-green-700">
                {filsToKwd(totalRevenue)}
              </p>
              <p className="text-xs text-muted-foreground">KWD</p>
            </div>
          </div>
        )}

        {sorted.length === 0 ? (
          <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
            No segment data yet. Insights populate after the first nightly rollup at 02:00 KW.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {sorted.map(seg => {
              const colorClass =
                SEGMENT_COLORS[seg.segment] ?? 'bg-muted text-foreground border-border';
              const icon = SEGMENT_ICONS[seg.segment] ?? '•';
              const sharePct =
                totalCustomers > 0 ? ((seg.count / totalCustomers) * 100).toFixed(1) : '0';
              const revSharePct =
                totalRevenue > 0 ? ((seg.totalMonetaryFils / totalRevenue) * 100).toFixed(1) : '0';

              return (
                <div key={seg.segment} className={`rounded-xl border p-4 space-y-3 ${colorClass}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-lg font-bold">{icon}</span>
                    <span className="text-xs font-medium opacity-70">{sharePct}% of customers</span>
                  </div>
                  <div>
                    <h3 className="text-base font-semibold capitalize">
                      {/* Use i18n label so the display matches the customers page badge */}
                      {t(`segment.${seg.segment}`) || seg.segment.replace(/_/g, ' ')}
                    </h3>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <p className="text-xs opacity-70">{t('count')}</p>
                      <p className="font-mono font-semibold">{seg.count}</p>
                    </div>
                    <div>
                      <p className="text-xs opacity-70">{t('revenue')}</p>
                      <p className="font-mono font-semibold">
                        {filsToKwd(seg.totalMonetaryFils)} KWD
                      </p>
                      <p className="text-xs opacity-60">{revSharePct}% of total</p>
                    </div>
                  </div>
                  {seg.recommendedAction && (
                    <div className="border-t border-current/10 pt-2">
                      <p className="text-xs opacity-70 mb-0.5">{t('recommendedAction')}</p>
                      <p className="text-xs leading-snug">{seg.recommendedAction}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
