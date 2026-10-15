/**
 * Arabic + English search folding. TS twin of SQL `public.ebda_ar_norm`
 * (migration 20261018000100_search_normalisation). The two MUST stay identical:
 * both are tested against NORMALIZE_VECTORS. Deliberately NO Unicode
 * normalize() and NO locale lowercasing: Postgres cannot reproduce either
 * immutably, so parity would break (Ruling SEARCH-2).
 *
 * Whitespace: only the explicit class [ \t\n\r\u00A0] collapses to one U+0020,
 * and the edge trim removes ONLY U+0020 (SQL `btrim(x, ' ')`). We deliberately
 * do NOT use String#trim(), which also strips U+2009, U+3000, U+FEFF, etc.
 */
// alef forms -> ا ; ى ی ئ -> ي ; ؤ -> و ; ة -> ه ; Persian kaf -> ك ; then ASCII upper, then digits
export const AR_FOLD_FROM = 'أإآٱىیئؤةکABCDEFGHIJKLMNOPQRSTUVWXYZ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹';
export const AR_FOLD_TO = 'اااايييوهكabcdefghijklmnopqrstuvwxyz01234567890123456789';

const FOLD = new Map<string, string>();
{
  const from = [...AR_FOLD_FROM];
  const to = [...AR_FOLD_TO];
  from.forEach((c, i) => FOLD.set(c, to[i]));
}

// tashkeel U+064B..U+065F, dagger alef U+0670, tatweel U+0640
const STRIP = /[\u064B-\u065F\u0670\u0640]/g;
// explicit set (NOT \s): Postgres' [[:space:]] is locale-dependent
const SPACES = /[ \t\n\r\u00A0]+/g;
const EDGE_SPACE = /^ +| +$/g;

export function normalizeArabicSearch(input: string): string {
  if (!input) return '';
  const stripped = input.replace(STRIP, '');
  let out = '';
  for (const ch of stripped) out += FOLD.get(ch) ?? ch;
  return out.replace(SPACES, ' ').replace(EDGE_SPACE, '');
}

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
