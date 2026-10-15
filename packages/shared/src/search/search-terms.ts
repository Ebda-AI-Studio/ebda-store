import { normalizeArabicSearch } from './arabic-normalize';

/** Must equal the DB CHECK on products.search_terms (migration 20261019000200). */
export const SEARCH_TERMS_MAX_LENGTH = 500;
export const SEARCH_TERMS_MAX_COUNT = 30;
const SEARCH_TERM_MAX_LENGTH = 60;
const SEPARATOR = ', ';

/**
 * Canonical stored form of products.search_terms: "a, b, c" or null.
 *
 * The output NEVER exceeds SEARCH_TERMS_MAX_LENGTH: the ", " joiner is wider
 * than the "," a merchant types, so a 500-char input could otherwise grow past
 * the DB CHECK and surface as a 500. Terms that would not fit are dropped.
 */
export function cleanSearchTerms(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  let length = 0;
  for (const part of raw.split(/[,،\n]/)) {
    const term = part.trim().slice(0, SEARCH_TERM_MAX_LENGTH);
    const key = normalizeArabicSearch(term);
    if (!key || seen.has(key)) continue;
    const next = length + (out.length ? SEPARATOR.length : 0) + term.length;
    if (next > SEARCH_TERMS_MAX_LENGTH) break;
    seen.add(key);
    out.push(term);
    length = next;
    if (out.length >= SEARCH_TERMS_MAX_COUNT) break;
  }
  return out.length ? out.join(SEPARATOR) : null;
}
