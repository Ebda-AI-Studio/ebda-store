/** Mirrors the API response shape from
 * `apps/api/src/services/answer-engine/dashboard.service.ts`. */

export interface AnswerEngineSummaryEngine {
  engine: string;
  /** Grounded checks only — an ungrounded fallback is not a citation. */
  totalChecks: number;
  citedCount: number;
  /** `null` when the engine has no grounded check yet (unknown, not 0%). */
  citedRate: number | null;
  groundedCaveat: boolean;
  /** True when the latest run could not perform grounded web search at all
   * (retired model, rejected tool, quota) — distinct from `groundedCaveat`
   * ("grounded, but cited nothing"). Takes priority in the UI. */
  groundingUnavailable: boolean;
}

export interface AnswerEngineTrendPoint {
  weekStart: string;
  totalChecks: number;
  citedCount: number;
  citedRate: number;
}

export interface AnswerEngineSummaryPrompt {
  engine: string;
  promptText: string;
  locale: string;
  cited: boolean;
  rank: number | null;
  snippet: string | null;
  competitorUrls: string[];
  runAt: string;
}

export interface AnswerEngineSummary {
  engines: AnswerEngineSummaryEngine[];
  trend: AnswerEngineTrendPoint[];
  prompts: AnswerEngineSummaryPrompt[];
  lastRunAt: string | null;
}

/** Human-friendly display name per engine — falls back to the raw key for
 * an engine this page doesn't know about yet. */
export function engineLabel(engine: string): string {
  switch (engine) {
    case 'gemini':
      return 'Google AI (Gemini)';
    case 'perplexity':
      return 'Perplexity';
    case 'openai':
      return 'ChatGPT (OpenAI)';
    default:
      return engine;
  }
}

export function formatPercent(rate: number | null): string {
  if (rate === null) return '—';
  return `${Math.round(rate * 100)}%`;
}

/** Mirrors the API response shape from
 * `apps/api/src/services/answer-engine/gsc-dashboard.service.ts` (Task 4). */

export interface GscTrendPoint {
  date: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
}

export interface GscTopQuery {
  query: string;
  impressions: number;
  clicks: number;
}

export interface GscDashboardTotals {
  impressions: number;
  clicks: number;
  ctr: number;
  avgPosition: number;
}

export interface GscDashboard {
  connected: boolean;
  hasData: boolean;
  trend: GscTrendPoint[];
  totals: GscDashboardTotals | null;
  topQueries: GscTopQuery[];
  lastUpdatedAt: string | null;
  /** Empty-state diagnosis from the API; absent = generic not-connected. */
  setup?: 'verifying' | 'awaiting_data';
}

/**
 * Average position, or an em dash when there is NO data. A position is 1 or more, so 0 (what the API reports for zero impressions) is
 * "unknown", never "position 0.0" (live: the Search Console card showed 0.0 with 0 impressions). `impressions` is optional: pass it
 * wherever it is known, a zero count also means no data.
 */
export function formatPosition(position: number, impressions?: number): string {
  if (impressions === 0 || !Number.isFinite(position) || position <= 0) return '\u2014';
  return position.toFixed(1);
}
