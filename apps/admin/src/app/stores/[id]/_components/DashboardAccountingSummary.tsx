'use client';

import { isRefusedThisSession, rememberRefusal } from '../../../../lib/plan-refusal-memo';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/i18n/useT';
import { apiGetQuiet } from '../../../../lib/api';
import { useFeatures } from '../../../../hooks/useFeatures';

import { formatMoney, REGION } from '@ebda/shared';
interface FinanceDashboard {
  thisMonth: { revenue: number; expenses: number; net: number };
  cash: Array<{ id: string; code: string; nameEn: string; balance: number }>;
  stockValue: number;
}

interface StockSnapshot {
  stockValue: number;
  openBackorderCount: number;
  backorderedDemandValue: number;
  reorderRulesCount: number;
}

interface SegmentRow {
  name: string;
  count: number;
  revenue: number;
}

const SEGMENT_LABEL: Record<string, string> = {
  vip: 'VIP',
  loyal: 'Loyal',
  potential: 'Active Buyer',
  new_customer: 'New',
  at_risk: 'At Risk',
  hibernating: 'Dormant',
  lost: 'Lost',
};

interface Props {
  storeId: string;
}

function fmtMoney(minor: number) {
  return formatMoney(minor, 'en', { hideSymbol: true, fixedDecimals: true });
}

/**
 * Surfaces Batch 1 + Batch 2 accounting numbers on the merchant dashboard.
 * Links directly into Finance + Stock hubs so the dashboard becomes a
 * jumping-off point, not a dead-end summary.
 */
export function DashboardAccountingSummary({ storeId }: Props) {
  const t = useT('stores.dashboard.accountingSummary');
  const [fin, setFin] = useState<FinanceDashboard | null>(null);
  const [stock, setStock] = useState<StockSnapshot | null>(null);
  const [topSegment, setTopSegment] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { isEnabled, isLoading: featuresLoading } = useFeatures();
  // Entitlements first (audit G-3): a store without accounting never fires the finance call just to get a 403.
  const hasAccounting = isEnabled('accounting.basic');

  useEffect(() => {
    if (featuresLoading) return;
    let cancelled = false;
    Promise.all([
      (hasAccounting
        ? apiGetQuiet<FinanceDashboard>(`/api/v1/stores/${storeId}/finance/dashboard`)
        : Promise.resolve({ data: null, error: null })
      ).catch(() => ({
        data: null,
        error: null,
      })),
      apiGetQuiet<StockSnapshot>(`/api/v1/stores/${storeId}/analytics/stock-snapshot`).catch(
        () => ({
          data: null,
          error: null,
        })
      ),
      // Fetch top RFM segment — graceful no-op if rollup hasn't run yet
      isRefusedThisSession('segments', storeId)
        ? Promise.resolve({ data: null, error: null })
        : apiGetQuiet<{ segments: SegmentRow[] }>(`/api/v1/stores/${storeId}/insights/segments`)
            .then(res => {
              const status = (res.error as { status?: number } | null)?.status;
              if (status === 402 || status === 403) rememberRefusal('segments', storeId);
              return res;
            })
            .catch(() => ({ data: null, error: null })),
    ])
      .then(([fRes, sRes, segRes]) => {
        if (cancelled) return;
        const f = (fRes as { data: FinanceDashboard | null }).data ?? null;
        const s = (sRes as { data: StockSnapshot | null }).data ?? null;
        const segData = (segRes as { data: { segments: SegmentRow[] } | null }).data;
        if (f) setFin(f);
        if (s) setStock(s);
        if (segData?.segments?.length) {
          // Top segment = highest customer count
          const top = segData.segments.reduce((a, b) => (b.count > a.count ? b : a));
          setTopSegment(top.name);
        }
        if (!f && !s) setError(t('error'));
      })
      .catch(() => {
        if (!cancelled) setError(t('error'));
      });
    return () => {
      cancelled = true;
    };
  }, [storeId, t, hasAccounting, featuresLoading]);

  if (error) return null; // silent failure — the existing StatsGrid still shows
  if (!fin && !stock) return null;

  const netPositive = (fin?.thisMonth.net ?? 0) >= 0;

  const tiles = [
    fin && {
      href: `/stores/${storeId}/finance/dashboard`,
      label: t('revenueThisMonth'),
      value: fmtMoney(fin.thisMonth.revenue),
      unit: REGION.currency,
      tone: 'primary' as const,
    },
    fin && {
      href: `/stores/${storeId}/finance/dashboard`,
      label: t('netThisMonth'),
      value: fmtMoney(fin.thisMonth.net),
      unit: REGION.currency,
      tone: netPositive ? ('success' as const) : ('danger' as const),
    },
    (fin || stock) && {
      href: `/stores/${storeId}/stock/dashboard`,
      label: t('stockValue'),
      value: fmtMoney(stock?.stockValue ?? fin?.stockValue ?? 0),
      unit: REGION.currency,
      tone: 'info' as const,
    },
    stock && {
      href: `/stores/${storeId}/stock/backorders`,
      label: t('openBackorders'),
      value: String(stock.openBackorderCount),
      unit: '',
      tone: stock.openBackorderCount > 0 ? ('warning' as const) : ('muted' as const),
    },
    topSegment && {
      href: `/stores/${storeId}/insights/segments`,
      label: t('topRfmSegment'),
      value: SEGMENT_LABEL[topSegment] ?? topSegment,
      unit: '',
      tone: 'primary' as const,
    },
  ].filter(Boolean) as Array<{
    href: string;
    label: string;
    value: string;
    unit: string;
    tone: 'primary' | 'success' | 'danger' | 'info' | 'warning' | 'muted';
  }>;

  const toneClass = {
    primary: 'border-primary/30 hover:border-primary',
    success: 'border-success/30 hover:border-success text-success-ink',
    danger: 'border-destructive/30 hover:border-destructive text-destructive-ink',
    info: 'border-info/30 hover:border-info',
    warning: 'border-warning/40 hover:border-warning text-warning-foreground',
    muted: 'border-border hover:border-muted-foreground text-muted-foreground',
  };

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        {t('title')}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {tiles.map(tile => (
          <Link
            key={tile.label}
            href={tile.href}
            className={`block rounded-2xl border p-4 transition-colors bg-card ${toneClass[tile.tone]}`}
          >
            <p className="text-xs font-medium text-muted-foreground">{tile.label}</p>
            <p className="mt-2 text-2xl font-bold tracking-tight">
              {tile.value}
              {tile.unit && (
                <span className="ms-1 text-sm font-medium text-muted-foreground">{tile.unit}</span>
              )}
            </p>
          </Link>
        ))}
      </div>
    </section>
  );
}
