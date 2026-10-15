import { normalizeArabicSearch } from './arabic-normalize';

/** Must equal the DB CHECK on products.search_terms (migration 20261019000200). */
export const SEARCH_TERMS_MAX_LENGTH = 500;
export const SEARCH_TERMS_MAX_COUNT = 30;
export const SEARCH_TERM_MAX_LENGTH = 60;
const SEPARATOR = ', ';

export interface SearchTermsAnalysis {
  /** Canonical stored form ("a, b, c") or null. Never longer than SEARCH_TERMS_MAX_LENGTH. */
  value: string | null;
  /** Distinct terms left out entirely (over the count cap or the length budget). */
  dropped: number;
  /** Kept terms that were cut to SEARCH_TERM_MAX_LENGTH characters. */
  truncated: number;
}

/**
 * Clean + cap products.search_terms, and report what was lost so the admin form can
 * say so instead of silently dropping words. The output NEVER exceeds
 * SEARCH_TERMS_MAX_LENGTH (the ", " joiner is wider than the typed ",", so a
 * 500-char input could otherwise grow past the DB CHECK and surface as a 500).
 * Idempotent: analyse(analyse(x).value).value === analyse(x).value (terms are cut
 * BEFORE trimming, so a cut never leaves trailing whitespace).
 */
export function analyzeSearchTerms(raw: string | null | undefined): SearchTermsAnalysis {
  if (raw == null) return { value: null, dropped: 0, truncated: 0 };
  const seen = new Set<string>();
  const out: string[] = [];
  let length = 0;
  let dropped = 0;
  let truncated = 0;
  for (const part of raw.split(/[,،\n]/)) {
    const trimmed = part.trim();
    const term = trimmed.slice(0, SEARCH_TERM_MAX_LENGTH).trim();
    const key = normalizeArabicSearch(term);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const next = length + (out.length ? SEPARATOR.length : 0) + term.length;
    if (out.length >= SEARCH_TERMS_MAX_COUNT || next > SEARCH_TERMS_MAX_LENGTH) {
      dropped++;
      continue;
    }
    if (term.length < trimmed.length) truncated++;
    out.push(term);
    length = next;
  }
  return { value: out.length ? out.join(SEPARATOR) : null, dropped, truncated };
}

/** Canonical stored form of products.search_terms: "a, b, c" or null. */
export function cleanSearchTerms(raw: string | null | undefined): string | null {
  return analyzeSearchTerms(raw).value;
}
