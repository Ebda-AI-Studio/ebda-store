/** Mirrors the API response shape from
 * `apps/api/src/services/answer-engine/dashboard.service.ts`. */

export interface AnswerEngineSummaryEngine {
  engine: string;
  totalChecks: number;
  citedCount: number;
  citedRate: number;
  groundedCaveat: boolean;
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

export function formatPercent(rate: number): string {
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
}

export function formatPosition(position: number): string {
  return position.toFixed(1);
}
