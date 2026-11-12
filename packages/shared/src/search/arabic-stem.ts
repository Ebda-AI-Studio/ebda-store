/**
 * Arabic LIGHT stemming for search (Ruling SEARCH-STEM-1). Pure TS, no Node-only API (runs on workerd).
 *
 * Input is ALREADY FOLDED text (`normalizeArabicSearch`: alef forms -> ا, ة -> ه, ى -> ي, no tashkeel), so every rule
 * below is written against the folded alphabet. The stem is an ADDITIONAL index/query form: it never replaces the
 * folded text, so an exact substring match still exists and still ranks first (see DO search).
 *
 * Rules, in order, each only when at least 3 letters remain:
 *   1. definite-article prefixes: وال بال كال فال لل ال
 *   2. one suffix: ات ون ين ان ها تين ه   (plural / dual / feminine ة; Egyptian commerce plurals شنطات, ساعات;
 *      no يه rule, so كوباية and كوبايات meet at كوباي)
 *   3. broken plurals: افعال (اقلام -> قلم), فعال (كتاب -> كتب, كلاب -> كلب)
 *   4. مفعل: a 4-letter word starting with م loses it (مكتب -> كتب), so مكتبة / مكتبات meet كتب
 * Not ISRI root extraction: measured on tests/search-eval (docs/plans/2026-11-12-arabic-stemming.md) light rules already
 * cover the commerce cases, and a full root extractor over-merges names (Ruling SEARCH-STEM-1, cost if wrong: recall only,
 * the stem arm is additive).
 */

const ARABIC_WORD = /^[ء-ي]+$/;
const PREFIXES = ['وال', 'بال', 'كال', 'فال', 'لل', 'ال'] as const;
const SUFFIXES = ['تين', 'ات', 'ون', 'ين', 'ان', 'ها', 'ه'] as const;
const MIN = 3;

/** Stem ONE folded word. Non-Arabic words (Latin, digits, mixed) come back unchanged. */
export function stemArabicWord(word: string): string {
  if (!ARABIC_WORD.test(word)) return word;
  let w = word;
  for (const p of PREFIXES) {
    if (w.startsWith(p) && w.length - p.length >= MIN) {
      w = w.slice(p.length);
      break;
    }
  }
  for (const s of SUFFIXES) {
    if (w.endsWith(s) && w.length - s.length >= MIN) {
      w = w.slice(0, -s.length);
      break;
    }
  }
  if (w.length === 5 && w[0] === 'ا' && w[3] === 'ا') w = w[1]! + w[2]! + w[4]!;
  else if (w.length === 4 && w[2] === 'ا') w = w[0]! + w[1]! + w[3]!;
  else if (w.length === 4 && w[0] === 'م') w = w.slice(1);
  return w;
}

/** The stemmed form of a folded query token (one token, no spaces). */
export const stemSearchToken = stemArabicWord;

/**
 * The stem document of folded index text: the stem of every word (split on non-letter/digit), de-duplicated,
 * space-joined. Used identically by the indexer; queries use `stemSearchToken`.
 */
export function stemSearchDoc(folded: string): string {
  const seen = new Set<string>();
  for (const w of folded.split(/[^\p{L}\p{N}]+/u)) if (w) seen.add(stemArabicWord(w));
  return [...seen].join(' ');
}
