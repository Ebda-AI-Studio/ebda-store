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
  /**
   * Smart (semantic) search index of this store (Task 12; the viewer of `product_embeddings`).
   * `products` = active, non-deleted products with text; `indexed` = with a current vector;
   * `failed` = this text could not be embedded (quarantined); `stale` = waiting for the indexer.
   * `semanticEnabled` = the vector leg is on for shoppers (SEARCH_SEMANTIC_ENABLED + a provider).
   */
  index?: SearchIndexStatus;
}

export interface SearchIndexStatus {
  products: number;
  indexed: number;
  stale: number;
  failed: number;
  semanticEnabled: boolean;
}
