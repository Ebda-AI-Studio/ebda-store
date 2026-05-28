'use client';

/**
 * AI Usage page — /stores/:id/ai-usage
 *
 * Shows the merchant their AI call consumption:
 *  - Top stat cards: today / this month / daily cap / monthly cap / remaining
 *  - Progress bars for daily + monthly quota
 *  - Sparkline of the last 30 days
 *  - Paginated table of recent AI calls with date, feature, tokens, cached status
 *
 * Bilingual EN + AR labels throughout.
 * Data: GET /api/v1/stores/:storeId/ai/usage/summary + /ai/usage/log
 */

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '../../../../components/AdminLayout';
import { useAuth } from '../../../../lib/auth';
import { apiGet } from '../../../../lib/api';

// ── Types ─────────────────────────────────────────────────────────────

interface SummaryData {
  today: number;
  thisMonth: number;
  dailyCap: number;
  monthlyCap: number;
  last30Days: Array<{ day: string; total: number }>;
}

interface UsageRow {
  id: string;
  feature: string;
  inputTokens: number;
  outputTokens: number;
  cachedHit: boolean;
  createdAt: string;
}

interface LogData {
  rows: UsageRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatFeature(feature: string): string {
  return feature.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ── Stat card ─────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  labelAr: string;
  value: number | string;
  accent?: boolean;
  warn?: boolean;
}

function StatCard({ label, labelAr, value, accent, warn }: StatCardProps) {
  return (
    <div
      className={`rounded-xl border bg-card p-4 shadow-sm ${accent ? 'border-primary/30' : ''} ${warn ? 'border-destructive/30' : ''}`}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xs text-muted-foreground/70" dir="rtl">
        {labelAr}
      </p>
      <p
        className={`mt-1 text-2xl font-bold tabular-nums ${accent ? 'text-primary' : ''} ${warn ? 'text-destructive' : 'text-foreground'}`}
      >
        {value}
      </p>
    </div>
  );
}

// ── Mini sparkline (pure SVG, no third-party charting lib) ─────────────

interface SparklineProps {
  data: Array<{ day: string; total: number }>;
}

function Sparkline({ data }: SparklineProps) {
  if (!data.length) return null;

  const max = Math.max(...data.map(d => d.total), 1);
  const width = 400;
  const height = 60;
  const pad = 4;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;

  const points = data.map((d, i) => {
    const x = pad + (i / Math.max(data.length - 1, 1)) * innerW;
    const y = pad + (1 - d.total / max) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      aria-label="Last 30 days usage sparkline"
      role="img"
    >
      {/* Baseline */}
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
        stroke="var(--primary, #ff6e00)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Main page ──────────────────────────────────────────────────────────

export default function AiUsagePage() {
  const params = useParams();
  const { isAuthenticated } = useAuth();
  const storeId = params?.id as string;

  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [log, setLog] = useState<LogData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const fetchData = useCallback(
    async (p: number) => {
      if (!isAuthenticated || !storeId) return;
      setLoadError(false);
      try {
        const [summaryRes, logRes] = await Promise.all([
          apiGet<{ data: SummaryData }>(`/api/v1/stores/${storeId}/ai/usage/summary`),
          apiGet<{ data: LogData }>(`/api/v1/stores/${storeId}/ai/usage/log?page=${p}&pageSize=20`),
        ]);
        if (summaryRes.error || logRes.error) {
          setLoadError(true);
          return;
        }
        setSummary(summaryRes.data?.data ?? null);
        setLog(logRes.data?.data ?? null);
      } catch {
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    },
    [isAuthenticated, storeId]
  );

  useEffect(() => {
    fetchData(page);
  }, [fetchData, page]);

  // ── Render ───────────────────────────────────────────────────────────

  if (loading) {
    return (
      <AdminLayout title="AI Usage" subtitle="">
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </AdminLayout>
    );
  }

  if (loadError || !summary) {
    return (
      <AdminLayout title="AI Usage" subtitle="">
        <div className="rounded-xl border bg-card p-8 text-center">
          <p className="text-sm text-destructive">Failed to load AI usage data.</p>
          <p className="text-xs text-muted-foreground mt-1" dir="rtl">
            تعذّر تحميل بيانات الاستخدام.
          </p>
        </div>
      </AdminLayout>
    );
  }

  const remaining = Math.max(0, summary.dailyCap - summary.today);
  const dailyPct = Math.min(100, Math.round((summary.today / Math.max(summary.dailyCap, 1)) * 100));
  const monthlyPct = Math.min(
    100,
    Math.round((summary.thisMonth / Math.max(summary.monthlyCap, 1)) * 100)
  );

  return (
    <AdminLayout
      title="AI Usage / استخدام الذكاء الاصطناعي"
      subtitle="Monitor your store's AI call consumption and remaining quota."
    >
      {/* ── Stat cards ─────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5 mb-6">
        <StatCard
          label="AI Calls Today"
          labelAr="استدعاءات اليوم"
          value={summary.today.toLocaleString()}
          accent
        />
        <StatCard
          label="Calls This Month"
          labelAr="استدعاءات الشهر"
          value={summary.thisMonth.toLocaleString()}
        />
        <StatCard
          label="Daily Cap"
          labelAr="الحد اليومي"
          value={summary.dailyCap.toLocaleString()}
        />
        <StatCard
          label="Monthly Cap"
          labelAr="الحد الشهري"
          value={summary.monthlyCap.toLocaleString()}
        />
        <StatCard
          label="Remaining Today"
          labelAr="المتبقي اليوم"
          value={remaining.toLocaleString()}
          warn={remaining < summary.dailyCap * 0.1}
        />
      </div>

      {/* ── Quota progress bars ────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-6 shadow-sm mb-6">
        <h2 className="text-base font-semibold text-foreground mb-4">
          Quota Usage / استخدام الحصة
        </h2>
        <div className="mb-4">
          <div className="flex justify-between text-xs mb-1">
            <span className="font-medium text-foreground">Daily ({dailyPct}%)</span>
            <span className="text-muted-foreground" dir="rtl">
              يومي
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${dailyPct >= 90 ? 'bg-destructive' : 'bg-primary'}`}
              style={{ width: `${dailyPct}%` }}
            />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-xs mb-1">
            <span className="font-medium text-foreground">Monthly ({monthlyPct}%)</span>
            <span className="text-muted-foreground" dir="rtl">
              شهري
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${monthlyPct >= 90 ? 'bg-destructive' : 'bg-primary'}`}
              style={{ width: `${monthlyPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* ── Sparkline ──────────────────────────────────────────────── */}
      {summary.last30Days.length > 0 && (
        <div className="rounded-xl border bg-card p-6 shadow-sm mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-foreground">Last 30 Days</h2>
            <span className="text-xs text-muted-foreground" dir="rtl">
              آخر 30 يوماً
            </span>
          </div>
          <Sparkline data={summary.last30Days} />
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>{summary.last30Days[0]?.day ?? ''}</span>
            <span>{summary.last30Days[summary.last30Days.length - 1]?.day ?? ''}</span>
          </div>
        </div>
      )}

      {/* ── Log table ──────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold text-foreground">Recent AI Calls</h2>
          <span className="text-xs text-muted-foreground" dir="rtl">
            آخر الاستدعاءات
          </span>
        </div>

        {!log || log.rows.length === 0 ? (
          <div className="px-6 py-8 text-center">
            <p className="text-sm text-muted-foreground">No AI calls recorded yet.</p>
            <p className="text-xs text-muted-foreground/70 mt-1" dir="rtl">
              لا توجد استدعاءات مسجّلة بعد.
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Date / التاريخ</th>
                    <th className="px-4 py-3 font-medium">Feature / الميزة</th>
                    <th className="px-4 py-3 font-medium">Tokens / الرموز</th>
                    <th className="px-4 py-3 font-medium">Status / الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {log.rows.map(row => (
                    <tr
                      key={row.id}
                      className="border-b last:border-0 hover:bg-muted/20 transition-colors"
                    >
                      <td className="px-4 py-3 text-foreground whitespace-nowrap">
                        {formatDate(row.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-foreground">{formatFeature(row.feature)}</td>
                      <td className="px-4 py-3 text-muted-foreground tabular-nums">
                        {row.inputTokens + row.outputTokens > 0
                          ? (row.inputTokens + row.outputTokens).toLocaleString()
                          : '—'}
                      </td>
                      <td className="px-4 py-3">
                        {row.cachedHit ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                            Cached / من الذاكرة
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                            Live / مباشر
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {log.pages > 1 && (
              <div className="flex items-center justify-between border-t px-6 py-3">
                <button
                  type="button"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="text-sm text-primary hover:underline disabled:pointer-events-none disabled:opacity-40"
                >
                  Previous / السابق
                </button>
                <span className="text-xs text-muted-foreground">
                  Page {log.page} of {log.pages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage(p => Math.min(log.pages, p + 1))}
                  disabled={page >= log.pages}
                  className="text-sm text-primary hover:underline disabled:pointer-events-none disabled:opacity-40"
                >
                  Next / التالي
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </AdminLayout>
  );
}
