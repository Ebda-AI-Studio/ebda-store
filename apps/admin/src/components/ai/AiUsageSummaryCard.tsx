'use client';

/**
 * AiUsageSummaryCard — reusable AI quota snapshot widget.
 *
 * Consumed by:
 *   1. The AI Tools page (/stores/:id/ai-tools) as an embedded card at the top
 *      so merchants see quota before they click any sweep button.
 *   2. The standalone AI Usage page (/stores/:id/ai-usage) which shows this card
 *      above the full paginated log table.
 *
 * Shows:
 *   - Today's count / dailyCap with progress bar
 *   - This month's count / monthlyCap with progress bar
 *   - Cache hit ratio
 *   - Mini sparkline (last 30 days)
 *   - "View detailed log" link → /stores/:id/ai-usage
 *
 * When `embedded` is true the card renders in a compact single-row layout
 * suited for insertion at the top of a busy page. When false (default) it
 * renders the full-width card used on the dedicated AI Usage page.
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { apiGet } from '../../lib/api';
import { useT } from '@/i18n/useT';
import { formatSpend } from '@/lib/ai-spend';
import { withNumerals } from '@ebda/shared';

// ── Types ──────────────────────────────────────────────────────────────

export interface AiUsageSummary {
  today: number;
  thisMonth: number;
  dailyCap: number;
  monthlyCap: number;
  /** Daily AI calls for the last 30 days, oldest first. */
  last30Days: Array<{ day: string; total: number }>;
  /**
   * AI spend in micros of the store's billing currency (issues 2204/2226).
   * `null` = nothing in the window has a configured rate — unknown, never 0.
   * `*UnpricedCount` = calls the amount EXCLUDES, so a non-zero count makes
   * the amount a floor, and the card says so.
   */
  todayCostMicros?: number | null;
  todayUnpricedCount?: number;
  monthCostMicros?: number | null;
  monthUnpricedCount?: number;
}

/** Spend line: the amount (or "—" when unknown) plus the floor caveat. */
function SpendFigure({
  micros,
  unpriced,
  t,
  size,
}: {
  micros: number | null | undefined;
  unpriced: number;
  t: ReturnType<typeof useT>;
  size: 'sm' | 'lg';
}) {
  return (
    <>
      <p
        className={`font-bold tabular-nums text-foreground ${size === 'lg' ? 'text-lg' : 'text-xs'}`}
      >
        {micros == null ? '—' : formatSpend(micros)}
      </p>
      {unpriced > 0 && (
        <p className="text-xs text-warning-ink">
          {t('spendUnpriced', { count: unpriced.toLocaleString(undefined, withNumerals()) })}
        </p>
      )}
    </>
  );
}

interface AiUsageSummaryCardProps {
  storeId: string;
  /**
   * When true, renders a compact inline summary row instead of the full card.
   * Used on the AI Tools page where screen space is shared with sweep controls.
   */
  embedded?: boolean;
  /** Called with each successful snapshot, so a page can gate its run buttons on the same numbers it shows. */
  onLoaded?: (summary: AiUsageSummary) => void;
}

// ── Sparkline ──────────────────────────────────────────────────────────

interface SparklineProps {
  data: Array<{ day: string; total: number }>;
  /** Height in pixels (default 40 for embedded, 60 for standalone). */
  height?: number;
  ariaLabel: string;
}

function Sparkline({ data, height = 60, ariaLabel }: SparklineProps) {
  if (!data.length) return null;

  const max = Math.max(...data.map(d => d.total), 1);
  const width = 400;
  const pad = 4;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;

  const points = data.map((d, i) => {
    const x = pad + (i / Math.max(data.length - 1, 1)) * innerW;
    const y = pad + (1 - d.total / max) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" aria-label={ariaLabel} role="img">
      <line
        x1={pad}
        y1={height - pad}
        x2={width - pad}
        y2={height - pad}
        stroke="currentColor"
        strokeOpacity={0.1}
        strokeWidth={1}
      />
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Progress bar helper ────────────────────────────────────────────────

function QuotaBar({
  label,
  current,
  cap,
  pct,
}: {
  label: string;
  current: number;
  cap: number;
  pct: number;
}) {
  const barColor = pct >= 90 ? 'bg-destructive' : 'bg-primary';
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium text-foreground">
          {label} — {current.toLocaleString(undefined, withNumerals())} /{' '}
          {cap.toLocaleString(undefined, withNumerals())} ({pct}%)
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────

export function AiUsageSummaryCard({
  storeId,
  embedded = false,
  onLoaded,
}: AiUsageSummaryCardProps) {
  const t = useT('components.aiUsageSummaryCard');
  const [summary, setSummary] = useState<AiUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchSummary = useCallback(async () => {
    if (!storeId) return;
    setError(false);
    try {
      // apiGet already unwraps the API's `{ success, data }` envelope, so
      // `data` IS the AiUsageSummary — reading `data.data` double-unwrapped to
      // undefined and forced the error state on every successful response.
      const { data, error: apiError } = await apiGet<AiUsageSummary>(
        `/api/v1/stores/${storeId}/ai/usage/summary`
      );
      if (apiError || !data) {
        setError(true);
        return;
      }
      setSummary(data);
      onLoaded?.(data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [storeId, onLoaded]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  // ── Loading state ──────────────────────────────────────────────────

  if (loading) {
    return (
      <div
        className={`rounded-md border bg-card shadow-sm ${embedded ? 'px-4 py-3' : 'p-6'}`}
        aria-busy="true"
      >
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span className="text-xs text-muted-foreground">{t('loading')}</span>
        </div>
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────────

  if (error || !summary) {
    return (
      <div
        className={`rounded-md border border-destructive/20 bg-card shadow-sm ${embedded ? 'px-4 py-3' : 'p-6'}`}
      >
        <p className="text-xs text-destructive-ink">{t('loadError')}</p>
      </div>
    );
  }

  const dailyPct = Math.min(100, Math.round((summary.today / Math.max(summary.dailyCap, 1)) * 100));
  const monthlyPct = Math.min(
    100,
    Math.round((summary.thisMonth / Math.max(summary.monthlyCap, 1)) * 100)
  );

  // Cache hit ratio: total rows ≥ 0, derive from last30Days total vs cached unknown.
  // We only have uncached counts from /summary — show daily remaining instead.
  const remaining = Math.max(0, summary.dailyCap - summary.today);
  const remainingWarn = remaining < summary.dailyCap * 0.1;

  // ── Embedded compact layout ────────────────────────────────────────

  if (embedded) {
    return (
      <div className="rounded-md border bg-card shadow-sm">
        {/* Header row */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            {/* Sparkle icon */}
            <svg
              className="h-4 w-4 text-primary"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z"
              />
            </svg>
            <span className="text-sm font-semibold text-foreground">{t('header')}</span>
          </div>
          <Link
            href={`/stores/${storeId}/ai-usage`}
            className="text-xs text-primary hover:underline"
          >
            {t('viewLog')}
          </Link>
        </div>

        {/* Stats + bars */}
        <div className="grid gap-4 px-4 py-3 sm:grid-cols-2">
          {/* Left: quota bars */}
          <div className="space-y-3">
            <QuotaBar
              label={t('quotaBarDaily')}
              current={summary.today}
              cap={summary.dailyCap}
              pct={dailyPct}
            />
            <QuotaBar
              label={t('quotaBarMonthly')}
              current={summary.thisMonth}
              cap={summary.monthlyCap}
              pct={monthlyPct}
            />
          </div>

          {/* Right: mini stats + sparkline */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{t('remainingToday')}</span>
              <span
                className={`font-bold tabular-nums ${remainingWarn ? 'text-destructive-ink' : 'text-foreground'}`}
              >
                {remaining.toLocaleString(undefined, withNumerals())}
              </span>
            </div>
            <div className="flex items-start justify-between gap-2 text-xs">
              <span className="text-muted-foreground">{t('spendMonth')}</span>
              <div className="text-end">
                <SpendFigure
                  micros={summary.monthCostMicros}
                  unpriced={summary.monthUnpricedCount ?? 0}
                  t={t}
                  size="sm"
                />
              </div>
            </div>
            {summary.last30Days.length > 0 && (
              <div className="mt-1">
                <Sparkline
                  data={summary.last30Days}
                  height={40}
                  ariaLabel={t('sparklineAriaLabel')}
                />
                <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                  <span>{summary.last30Days[0]?.day ?? ''}</span>
                  <span>{summary.last30Days[summary.last30Days.length - 1]?.day ?? ''}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Full standalone layout (used on the /ai-usage page) ───────────

  return (
    <div className="rounded-md border bg-card p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground">{t('standaloneHeader')}</h2>
        <Link href={`/stores/${storeId}/ai-usage`} className="text-xs text-primary hover:underline">
          {t('viewLog')}
        </Link>
      </div>

      {/* Quota bars */}
      <div className="space-y-4 mb-6">
        <QuotaBar
          label={t('quotaBarDaily')}
          current={summary.today}
          cap={summary.dailyCap}
          pct={dailyPct}
        />
        <QuotaBar
          label={t('quotaBarMonthly')}
          current={summary.thisMonth}
          cap={summary.monthlyCap}
          pct={monthlyPct}
        />
      </div>

      {/* Stat chips */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg bg-muted/40 px-3 py-2">
          <p className="text-xs text-muted-foreground">{t('statToday')}</p>
          <p className="text-lg font-bold tabular-nums text-primary">
            {summary.today.toLocaleString(undefined, withNumerals())}
          </p>
        </div>
        <div className="rounded-lg bg-muted/40 px-3 py-2">
          <p className="text-xs text-muted-foreground">{t('statThisMonth')}</p>
          <p className="text-lg font-bold tabular-nums text-foreground">
            {summary.thisMonth.toLocaleString(undefined, withNumerals())}
          </p>
        </div>
        <div className="rounded-lg bg-muted/40 px-3 py-2">
          <p className="text-xs text-muted-foreground">{t('statDailyCap')}</p>
          <p className="text-lg font-bold tabular-nums text-foreground">
            {summary.dailyCap.toLocaleString(undefined, withNumerals())}
          </p>
        </div>
        <div className="rounded-lg bg-muted/40 px-3 py-2">
          <p className="text-xs text-muted-foreground">{t('statRemaining')}</p>
          <p
            className={`text-lg font-bold tabular-nums ${remainingWarn ? 'text-destructive-ink' : 'text-foreground'}`}
          >
            {remaining.toLocaleString(undefined, withNumerals())}
          </p>
        </div>
      </div>

      {/* Spend (issues 2204/2226) — the figure the log's cost column sums. */}
      <div className="mb-4 grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-muted/40 px-3 py-2">
          <p className="text-xs text-muted-foreground">{t('spendToday')}</p>
          <SpendFigure
            micros={summary.todayCostMicros}
            unpriced={summary.todayUnpricedCount ?? 0}
            t={t}
            size="lg"
          />
        </div>
        <div className="rounded-lg bg-muted/40 px-3 py-2">
          <p className="text-xs text-muted-foreground">{t('spendMonth')}</p>
          <SpendFigure
            micros={summary.monthCostMicros}
            unpriced={summary.monthUnpricedCount ?? 0}
            t={t}
            size="lg"
          />
        </div>
      </div>

      {/* Sparkline */}
      {summary.last30Days.length > 0 && (
        <div>
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>{t('last30Days')}</span>
          </div>
          <Sparkline data={summary.last30Days} height={60} ariaLabel={t('sparklineAriaLabel')} />
          <div className="mt-1 flex justify-between text-xs text-muted-foreground">
            <span>{summary.last30Days[0]?.day ?? ''}</span>
            <span>{summary.last30Days[summary.last30Days.length - 1]?.day ?? ''}</span>
          </div>
        </div>
      )}
    </div>
  );
}
