/**
 * Arabic + English search folding. The fold itself (`foldArabic`) is the foundation's (vendored, foundation.lock.json,
 * Ruling FDN-TEXT-1): TS twin of SQL `public.ebda_ar_norm` (migration 20261019000100_search_normalisation). The two MUST stay
 * identical: both are tested against NORMALIZE_VECTORS. Deliberately NO Unicode normalize() and NO locale lowercasing:
 * Postgres cannot reproduce either immutably, so parity would break (Ruling SEARCH-2).
 */
import { foldArabic } from '../foundation/text';

export { AR_FOLD_FROM, AR_FOLD_TO } from '../foundation/text';

export const normalizeArabicSearch = foldArabic;

export function searchTokens(input: string, max = 8): string[] {
  return normalizeArabicSearch(input ?? '')
    .split(' ')
    .filter(Boolean)
    .slice(0, max);
}

/** Escape a token for a LIKE pattern with the default `\` escape. */
export function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, m => `\\${m}`);
}
