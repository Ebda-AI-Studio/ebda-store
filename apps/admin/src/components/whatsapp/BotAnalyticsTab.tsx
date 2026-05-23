'use client';

/**
 * Bot Analytics Tab — Phase 5 bot intelligence.
 *
 * Shows a per-store WhatsApp ordering bot conversion funnel dashboard:
 *   - Date range picker (reuses DateRangePicker)
 *   - 4 top stat cards: sessions / paid / conversion rate / llm calls
 *   - Vertical funnel visualization with per-step counts + drop-off %
 *   - Intent breakdown table
 *   - Input modality breakdown (text / voice / image / button taps)
 *   - Language breakdown (EN / AR)
 *   - LLM stats footer card
 *
 * Data: proxied through FWB GET /stores/:id/bot-analytics?from=&to=
 * (FWB decrypts the wbsApiKey and forwards to WBS /external/bot-analytics)
 *
 * Privacy: dashboard shows ONLY aggregates. No phone numbers or
 * individual customer events are ever included in the response.
 */

import { useState, useEffect, useCallback } from 'react';
import { DateRangePicker } from '../DateRangePicker';
import { apiGet } from '../../lib/api';
import type { Period, ResolvedDateRange } from '../../app/stores/[id]/analytics/_components/types';
import { resolveDateRange } from '../../app/stores/[id]/analytics/_components/types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FunnelStep {
  step: string;
  label: string;
  count: number;
  dropOffFromPrev: number;
}

interface BotAnalyticsData {
  windowFrom: string;
  windowTo: string;
  totalSessions: number;
  funnel: FunnelStep[];
  intentBreakdown: Record<string, number>;
  llmStats: {
    totalLlmCalls: number;
    avgConfidence: number | null;
    fallbackToKeyword: number;
  };
  inputBreakdown: {
    text: number;
    voice: number;
    image: number;
    button_tap: number;
  };
  languageBreakdown: Record<string, number>;
  conversionRate: number;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

function FunnelBar({ step, maxCount }: { step: FunnelStep; maxCount: number }) {
  const pct = maxCount > 0 ? (step.count / maxCount) * 100 : 0;
  const dropOffDisplay =
    step.dropOffFromPrev > 0 ? `↓ ${(step.dropOffFromPrev * 100).toFixed(1)}% drop-off` : null;

  return (
    <div className="flex flex-col gap-1">
      {dropOffDisplay && <div className="text-xs text-destructive/80 ps-1">{dropOffDisplay}</div>}
      <div className="flex items-center gap-3">
        <div
          className="rounded-lg bg-primary/15 flex items-center px-3 py-2 min-w-0"
          style={{ width: `${Math.max(pct, 8)}%` }}
        >
          <span className="text-sm font-medium truncate text-primary">{step.label}</span>
        </div>
        <span className="text-sm tabular-nums text-foreground shrink-0">
          {step.count.toLocaleString()}
        </span>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function BotAnalyticsTab({ storeId }: { storeId: string }) {
  const [period, setPeriod] = useState<Period>('last_30');
  const [custom, setCustom] = useState<ResolvedDateRange | undefined>();
  const [data, setData] = useState<BotAnalyticsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState(false);

  const fetchData = useCallback(
    async (p: Period, c?: ResolvedDateRange) => {
      if (!storeId) return;
      setLoading(true);
      setError(null);
      setNotConnected(false);

      const range = resolveDateRange(p, c);
      const fromIso = range.startDate.toISOString();
      const toIso = range.endDate.toISOString();

      try {
        const { data: result, error: apiError } = await apiGet<BotAnalyticsData>(
          `/api/v1/stores/${storeId}/bot-analytics?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
        );

        if (apiError) {
          // Check for specific error codes from the proxy endpoint
          const code = (apiError as { code?: string }).code;
          if (code === 'WBS_NOT_CONNECTED') {
            setNotConnected(true);
          } else {
            setError(apiError.message || 'Failed to load analytics data.');
          }
          return;
        }

        if (result) setData(result);
      } catch (err) {
        setError('Could not load analytics. Please check your WBS connection.');
      } finally {
        setLoading(false);
      }
    },
    [storeId]
  );

  useEffect(() => {
    fetchData(period, custom);
  }, [storeId, period, custom, fetchData]);

  const handlePeriodChange = (p: Period, c?: ResolvedDateRange) => {
    setPeriod(p);
    setCustom(c);
  };

  // ── Render helpers ─────────────────────────────────────────────────────────

  if (notConnected) {
    return (
      <div className="rounded-xl border border-border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
        WBS is not connected for this store. Configure the integration in the{' '}
        <strong>Connection</strong> tab first.
      </div>
    );
  }

  const maxCount = data ? Math.max(...data.funnel.map(s => s.count), 1) : 1;

  // Sort intent breakdown by count desc
  const intentEntries = data
    ? Object.entries(data.intentBreakdown).sort(([, a], [, b]) => b - a)
    : [];

  // Language totals
  const langTotal = data ? Object.values(data.languageBreakdown).reduce((s, v) => s + v, 0) : 0;

  // Input totals for % share
  const inputTotal = data ? Object.values(data.inputBreakdown).reduce((s, v) => s + v, 0) : 0;

  return (
    <div className="space-y-6">
      {/* Date range picker */}
      <DateRangePicker period={period} custom={custom} onChange={handlePeriodChange} />

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Dashboard */}
      {!loading && data && (
        <>
          {/* Top stat cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label="Total sessions"
              value={data.totalSessions.toLocaleString()}
              sub="bot conversations started"
            />
            <StatCard
              label="Paid orders"
              value={(data.funnel.find(s => s.step === 'order_paid')?.count ?? 0).toLocaleString()}
              sub="confirmed payments"
            />
            <StatCard
              label="Conversion rate"
              value={`${(data.conversionRate * 100).toFixed(1)}%`}
              sub="sessions → paid"
            />
            <StatCard
              label="LLM calls"
              value={data.llmStats.totalLlmCalls.toLocaleString()}
              sub={
                data.llmStats.avgConfidence != null
                  ? `avg confidence ${(data.llmStats.avgConfidence * 100).toFixed(0)}%`
                  : 'Gemini intent classifier'
              }
            />
          </div>

          {/* Funnel */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold mb-4">Conversion Funnel</h3>
            <div className="flex flex-col gap-3">
              {data.funnel.map(step => (
                <FunnelBar key={step.step} step={step} maxCount={maxCount} />
              ))}
            </div>
            {data.totalSessions === 0 && (
              <p className="text-sm text-muted-foreground mt-4 text-center">
                No sessions recorded in this date window yet.
              </p>
            )}
          </div>

          {/* Intent breakdown */}
          {intentEntries.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-5">
              <h3 className="text-sm font-semibold mb-4">Intent Breakdown</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="pb-2 text-start font-medium">Intent</th>
                    <th className="pb-2 text-end font-medium">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {intentEntries.map(([intent, count]) => (
                    <tr key={intent} className="border-b border-border/50 last:border-0">
                      <td className="py-2 font-mono text-xs">{intent}</td>
                      <td className="py-2 text-end tabular-nums">{count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Bottom row: input breakdown + language */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Input modality */}
            <div className="rounded-xl border border-border bg-card p-5">
              <h3 className="text-sm font-semibold mb-3">Input Modality</h3>
              <div className="grid grid-cols-2 gap-3">
                {(
                  [
                    { key: 'text', label: 'Text' },
                    { key: 'voice', label: 'Voice' },
                    { key: 'image', label: 'Image' },
                    { key: 'button_tap', label: 'Button' },
                  ] as const
                ).map(({ key, label }) => {
                  const count = data.inputBreakdown[key] ?? 0;
                  const share = inputTotal > 0 ? ((count / inputTotal) * 100).toFixed(0) : '0';
                  return (
                    <div key={key} className="rounded-lg bg-muted/40 p-3">
                      <div className="text-xs text-muted-foreground">{label}</div>
                      <div className="text-lg font-semibold tabular-nums">
                        {count.toLocaleString()}
                      </div>
                      <div className="text-xs text-muted-foreground">{share}%</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Language breakdown */}
            <div className="rounded-xl border border-border bg-card p-5">
              <h3 className="text-sm font-semibold mb-3">Language</h3>
              {langTotal > 0 ? (
                <div className="space-y-3">
                  {Object.entries(data.languageBreakdown)
                    .sort(([, a], [, b]) => b - a)
                    .map(([lang, count]) => {
                      const pct = Math.round((count / langTotal) * 100);
                      return (
                        <div key={lang}>
                          <div className="flex justify-between text-sm mb-1">
                            <span className="uppercase font-medium">{lang}</span>
                            <span className="tabular-nums text-muted-foreground">
                              {count.toLocaleString()} ({pct}%)
                            </span>
                          </div>
                          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-primary"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No language data yet.</p>
              )}
            </div>
          </div>

          {/* LLM stats footer */}
          <div className="rounded-xl border border-border bg-muted/30 p-4 flex flex-wrap gap-6 text-sm">
            <div>
              <span className="text-muted-foreground me-1">Total LLM calls:</span>
              <span className="font-medium tabular-nums">
                {data.llmStats.totalLlmCalls.toLocaleString()}
              </span>
            </div>
            {data.llmStats.avgConfidence != null && (
              <div>
                <span className="text-muted-foreground me-1">Avg confidence:</span>
                <span className="font-medium">
                  {(data.llmStats.avgConfidence * 100).toFixed(1)}%
                </span>
              </div>
            )}
            <div>
              <span className="text-muted-foreground me-1">Keyword fallbacks:</span>
              <span className="font-medium tabular-nums">
                {data.llmStats.fallbackToKeyword.toLocaleString()}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
