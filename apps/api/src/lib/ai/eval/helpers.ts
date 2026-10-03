/**
 * Shared pure helpers for deterministic AI-output checks. No network, no
 * DB — every function here must be safe to call thousands of times in a
 * CI unit test.
 */
import { containsArabic } from '../description-richness';

export { containsArabic };

const ARABIC_CHAR_G = /[؀-ۿݐ-ݿ]/g;
const LATIN_CHAR_G = /[A-Za-z]/g;

function scriptCharCount(v: string, pattern: RegExp): number {
  return (v.match(pattern) ?? []).length;
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Placeholder / degenerate content a real generation should never emit. */
const PLACEHOLDER_PATTERNS = [
  /^n\/a$/i,
  /^todo$/i,
  /^tbd$/i,
  /^undefined$/i,
  /^null$/i,
  /^\.{3,}$/,
  /^-+$/,
  /^lorem ipsum/i,
  /^\[.*\]$/, // "[insert text here]"
];

export function isPlaceholder(v: unknown): boolean {
  if (typeof v !== 'string') return true;
  const t = v.trim();
  if (!t) return true;
  return PLACEHOLDER_PATTERNS.some(p => p.test(t));
}

export function withinLength(v: unknown, max: number): boolean {
  return typeof v === 'string' && v.length <= max;
}

// Character-count thresholds, NOT contiguous-run regexes — real sentences
// have spaces between words, so a naive `{15,}` contiguous-character regex
// never matches a multi-word sentence and silently never fires. Counting
// total script characters anywhere in the field is what actually catches
// "the whole field is still in the wrong language" while staying lenient
// on short transliterated brand names / product codes.

/**
 * A field expected to hold English/Latin content must not be dominated by
 * Arabic script — a sign the model returned Arabic in the wrong slot (or
 * forgot to translate). A couple of transliterated words (product name in
 * parentheses etc.) are fine; 12+ Arabic letters means it's substantially
 * Arabic content, not a stray fragment.
 */
export function noLargeArabicSpan(v: unknown): boolean {
  if (typeof v !== 'string') return true;
  return scriptCharCount(v, ARABIC_CHAR_G) < 12;
}

/**
 * A field expected to hold Arabic content must not be dominated by
 * untranslated Latin text — a sign the model left the English source in
 * place instead of translating it. Threshold is generous (25 Latin
 * letters) so brand names / product codes / units (every translation
 * prompt's own "preserve these" instruction) don't trip it.
 */
export function noLargeUntranslatedLatinSpan(v: unknown): boolean {
  if (typeof v !== 'string') return true;
  return scriptCharCount(v, LATIN_CHAR_G) < 25;
}

function normalizeTokens(s: string | null | undefined): string[] {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4); // drop short/stopword-ish tokens
}

/**
 * Containment-style token-overlap ratio: what fraction of `text`'s
 * meaningful (length>=4) tokens also appear in `reference`. Used as the
 * near-duplication heuristic — an FAQ answer that's mostly composed of
 * words already in the product description is very likely a paraphrase
 * of it rather than new information (the reported regression class).
 * Returns 0 when either side has no scoreable tokens.
 */
export function tokenOverlapRatio(
  text: string | null | undefined,
  reference: string | null | undefined
): number {
  const a = new Set(normalizeTokens(text));
  const b = new Set(normalizeTokens(reference));
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return common / a.size;
}

/** Case-insensitive duplicate detector for a list of short strings. */
export function hasCaseInsensitiveDuplicates(items: string[]): boolean {
  const seen = new Set<string>();
  for (const raw of items) {
    const key = raw.trim().toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/** Regex guard: output must not mention payment-gateway backend company names — customers only see method names (KNET/Visa/etc), never Tap/MyFatoorah/Hesabe/UPayments. Mirrors the bulk-ai-faq-aeo prompt's own explicit rule. */
const GATEWAY_COMPANY_NAMES = /\b(tap payments|myfatoorah|hesabe|upayments)\b/i;
export function mentionsPaymentGatewayCompany(v: unknown): boolean {
  return typeof v === 'string' && GATEWAY_COMPANY_NAMES.test(v);
}

/** Loose price/out-of-stock claim detector — SEO meta must never mention either per the ai.service.ts prompt's own rule. */
const PRICE_OR_STOCK_CLAIM =
  /(EGP|K[W]D|ج\.م|جنيه|KD\s?\d|[$€£]\s?\d|\bprice\b|\bout of stock\b|\bsold out\b|نفد(?:ت)?\s*الكمية|غير متوفر)/i;
export function mentionsPriceOrStockClaim(v: unknown): boolean {
  return typeof v === 'string' && PRICE_OR_STOCK_CLAIM.test(v);
}

/**
 * Deterministic anti-hallucination guard: extracts every numeric
 * size/weight/capacity/percentage token ("350ml", "2kg", "10%") from a
 * text. Used to catch the exact regression class the merchant reported —
 * a generator stating a spec number that isn't anywhere in the source
 * description. This is a heuristic proxy for full grounding (the model
 * judge does the deeper semantic check); it only catches NUMERIC
 * inventions, not e.g. an invented color or material name.
 */
const NUMERIC_SPEC =
  /\b\d+(?:\.\d+)?\s?(?:cm|mm|km|m|kg|g|mg|ml|l|litre|litres|liter|liters|inch|inches|in|%|oz|lb|lbs|major|kd|piece|pieces|pcs)\b/gi;

export function extractNumericSpecTokens(text: string | null | undefined): string[] {
  const matches = (text ?? '').match(NUMERIC_SPEC) ?? [];
  return matches.map(m => m.toLowerCase().replace(/\s+/g, ''));
}

/** True when `answer` states a numeric spec that does not appear (same number+unit) anywhere in `reference`. */
export function hasInventedNumericSpec(
  answer: string | null | undefined,
  reference: string | null | undefined
): boolean {
  const answerTokens = extractNumericSpecTokens(answer);
  if (answerTokens.length === 0) return false;
  const refTokens = new Set(extractNumericSpecTokens(reference));
  return answerTokens.some(t => !refTokens.has(t));
}
