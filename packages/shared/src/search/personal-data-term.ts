/**
 * Is a search term shaped like personal data? (search program P0; Rulings SEARCH-T5-6, SEARCH-T5-9)
 *
 * One test, two callers, so they can never disagree:
 * - the API's first-party search log (`apps/api/src/services/search-log.service.ts`) never stores
 *   such a term;
 * - the storefront's ad-pixel `Search` event (`apps/web/src/components/MarketingPixels.tsx`
 *   `trackSearch`) sends the event WITHOUT the term when it is personal-data shaped.
 *
 * Pure, no I/O, safe in the browser and on the Worker.
 */
import { normalizeArabicSearch } from './arabic-normalize';

// Every pattern runs on the FOLDED term (`foldSearchLogTerm`): NFKC (fullwidth digits and `＠`
// become ASCII), invisible format characters removed (RLM/LRM/ZWJ/ZWNJ/zero-width space), then
// the search normaliser (Arabic-Indic / Persian digits to ASCII, Latin lower case, single spaces).
/** Any `@` (a half-typed address is still an address). */
const EMAIL_LIKE = /@/;
/**
 * 8+ digits with ANY non-letter between them (space, dash of any kind, slash, underscore,
 * comma, dot, brackets): a phone (local, +20, 0020) or a 14-digit national id.
 * Accepted false positives (Ruling SEARCH-T5-3): `size 38 40 42 44`, `2024/2025`, 8+ digit
 * barcodes. The log is lossy by design; the search itself is unaffected.
 */
const PHONE_LIKE = /\d(?:[^\p{L}\d]*\d){7,}/u;
/** Order numbers: `ORD<sep><base36 secs>…` and the legacy `ORD-<ms>-<hex>`, any separator. */
const ORDER_NUMBER_LIKE = /(?:^|[^\p{L}\d])ord[^\p{L}\d]+[a-z\d]{5,}/u;
/** WhatsApp payment-link order numbers `WA<sep><6+ with a digit><sep><5+>` (stricter: "wa" is a Franco word). */
const WA_ORDER_NUMBER_LIKE =
  /(?:^|[^\p{L}\d])wa[^\p{L}\d]+(?=[a-z]*\d)[a-z\d]{6,}[^\p{L}\d]+[a-z\d]{5,}/u;
const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
/** Links can carry tokens and tracking ids. */
const URL_LIKE = /:\/\/|(?:^|\s)www\./;
/** Invisible format characters (bidi marks, zero-width joiners/spaces, soft hyphen). */
const FORMAT_CHARS = /\p{Cf}/gu;

/** A 20+ char letters-and-digits run that is mostly random: a cuid, a hex token, a payment reference. */
function hasIdLikeToken(norm: string): boolean {
  for (const tok of norm.split(/[\s/?&=#]+/)) {
    if (tok.length < 20 || !/^[a-z0-9_-]+$/.test(tok)) continue;
    if (/^[0-9a-f_-]+$/.test(tok) && /\d/.test(tok)) return true; // hex token
    const digits = tok.replace(/[^0-9]/g, '').length;
    if (/[a-z]/.test(tok) && digits / tok.length >= 0.2) return true;
  }
  return false;
}

/**
 * The one folding both the PII gate and the stored value use, so they can never disagree:
 * NFKC, strip invisible format characters, then the shared search normaliser.
 */
export function foldSearchLogTerm(raw: string): string {
  return normalizeArabicSearch((raw ?? '').normalize('NFKC').replace(FORMAT_CHARS, ''));
}

/**
 * True for a term that may identify a person or an order: an email, a phone or national id
 * (in any digit script, with any separators or invisible marks), an order number, an
 * id/token, or a link. Folds first, so it is safe on a raw or an already-folded term.
 */
export function isPersonalDataTerm(term: string): boolean {
  const norm = foldSearchLogTerm(term);
  return (
    EMAIL_LIKE.test(norm) ||
    PHONE_LIKE.test(norm) ||
    ORDER_NUMBER_LIKE.test(norm) ||
    WA_ORDER_NUMBER_LIKE.test(norm) ||
    UUID_LIKE.test(norm) ||
    URL_LIKE.test(norm) ||
    hasIdLikeToken(norm)
  );
}
