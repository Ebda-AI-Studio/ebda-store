'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { AdminLayout } from '@/components/AdminLayout';
import { PageState } from '@/components/PageState';
import { useT } from '@/i18n/useT';
import { pickNarration } from '@/i18n/narration';
import { apiGet } from '@/lib/api';
import { minorToMajor } from '@/lib/format';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RfmSegmentRow {
  segment: string;
  count: number;
  totalMonetaryFils: number;
  recommendedAction: string | null;
  recommendedActionAr?: string | null;
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
  at_risk: 'bg-warning/10 text-warning-ink border-warning/30',
  hibernating: 'bg-yellow-100 text-yellow-900 border-yellow-200',
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
  const tc = useT('common');
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('insights.segments');
  const locale = useLocale();

  const [data, setData] = useState<SegmentsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!storeId) return;
    apiGet<SegmentsData>(`/api/v1/stores/${storeId}/insights/segments`)
      .then(({ data: d, error: apiError }) => {
        if (apiError) setError(apiError.message);
        else if (d) setData(d);
      })
      .catch(() => setError(t('loadFailed')));
  }, [storeId, reloadKey, t]);

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

  const totalCustomers = data.segments.reduce((sum, s) => sum + s.count, 0);
  const totalRevenue = data.segments.reduce((sum, s) => sum + s.totalMonetaryFils, 0);

  // Sort by count descending
  const sorted = [...data.segments].sort((a, b) => b.count - a.count);

  // Locale-aware AI narration body (#1933) — the API already returns both
  // `en` and `ar`; render whichever matches the admin's active locale
  // instead of always the English one.
  const narration = pickNarration(data.narration, locale);

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="max-w-5xl space-y-6">
        {/* AI narration callout */}
        {narration && (
          <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm italic text-muted-foreground">
            <span className="not-italic font-semibold text-primary">{t('aiLabel')}</span>{' '}
            {narration}
          </div>
        )}

        {/* Summary */}
        {totalCustomers > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-border p-4 space-y-1">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                {t('totalSegmentedCustomers')}
              </p>
              <p className="text-2xl font-semibold font-mono">{totalCustomers}</p>
            </div>
            <div className="rounded-xl border border-border p-4 space-y-1">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                {t('totalMonetaryValue')}
              </p>
              <p className="text-2xl font-semibold font-mono text-green-700">
                {minorToMajor(totalRevenue)}
              </p>
              <p className="text-xs text-muted-foreground">{tc('egp')}</p>
            </div>
          </div>
        )}

        {sorted.length === 0 ? (
          <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
            {t('noSegmentData')}
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

              const action =
                locale === 'ar'
                  ? (seg.recommendedActionAr ?? seg.recommendedAction)
                  : seg.recommendedAction;

              // Drill-down: the card opens the Customers list filtered to this
              // segment (server-side `?segment=`), guests included.
              return (
                <Link
                  key={seg.segment}
                  href={`/stores/${storeId}/customers?segment=${encodeURIComponent(seg.segment)}`}
                  aria-label={t('viewSegmentCustomers', { segment: t(`segment.${seg.segment}`) })}
                  className={`block rounded-xl border p-4 space-y-3 transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${colorClass}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-lg font-bold">{icon}</span>
                    <span className="text-xs font-medium opacity-70">
                      {t('shareOfCustomers', { pct: sharePct })}
                    </span>
                  </div>
                  <div>
                    <h3 className="text-base font-semibold capitalize">
                      {/* i18n label so the display matches the customers page badge.
                          Every RfmSegment has a key in en + ar, so no fallback —
                          `useT` returns the raw key, never '' (the old `||`
                          fallback could not fire). */}
                      {t(`segment.${seg.segment}`)}
                    </h3>
                  </div>
                  <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                    <div>
                      <p className="text-xs opacity-70">{t('count')}</p>
                      <p className="font-mono font-semibold">{seg.count}</p>
                    </div>
                    <div>
                      <p className="text-xs opacity-70">{t('revenue')}</p>
                      <p className="font-mono font-semibold">
                        {minorToMajor(seg.totalMonetaryFils)} {tc('egp')}
                      </p>
                      <p className="text-xs opacity-60">
                        {t('shareOfTotal', { pct: revSharePct })}
                      </p>
                    </div>
                  </div>
                  {action && (
                    <div className="border-t border-current/10 pt-2">
                      <p className="text-xs opacity-70 mb-0.5">{t('recommendedAction')}</p>
                      <p className="text-xs leading-snug">{action}</p>
                    </div>
                  )}
                  <p className="text-xs font-medium underline-offset-2 hover:underline">
                    {t('viewCustomers')} {locale === 'ar' ? '←' : '→'}
                  </p>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
