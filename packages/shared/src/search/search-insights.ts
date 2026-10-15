/**
 * Contract of `GET /api/v1/stores/:storeId/search-insights` (search program, Task 6).
 * Shared by the API route and the admin page + analytics card.
 */
export type SearchInsightsFilter = 'zero' | 'all';

export interface SearchInsightsTerm {
  term: string;
  searches: number;
  zeroResults: number;
  /** Result count of the term's most recent search (not the max). */
  lastResultCount: number;
}

export interface SearchInsightsResponse {
  days: number;
  /** Totals count EVERY search; `terms` lists only terms searched at least twice (privacy floor). */
  totals: { searches: number; zeroResultSearches: number; zeroResultRate: number | null };
  terms: SearchInsightsTerm[];
}
