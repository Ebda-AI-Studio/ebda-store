/**
 * SEO language guard (UX:SEO-4, QA P2-1): Arabic text must not land in an English field (Arabic text = more than
 * half its letters Arabic, `isMostlyArabic`; an English title naming the brand in Arabic is English). The AI sometimes answers
 * with the languages swapped, and a merchant can paste Arabic into the English title. Search results then show the
 * wrong language to the wrong visitors, so the page swaps what is clearly swapped and refuses the rest, naming
 * the fields.
 */

const ARABIC_SCRIPT = /[؀-ۿݐ-ݿࢠ-ࣿ]/;

export function hasArabicScript(value: string): boolean {
  return ARABIC_SCRIPT.test(value);
}

const LETTER = /\p{L}/gu;
const ARABIC_LETTER = /\p{Script=Arabic}/u;

/**
 * Is this text written in Arabic, rather than English that NAMES something Arabic? (PR #512 review.) The rule:
 * more than half of its LETTERS are Arabic script. Digits, spaces and punctuation do not count either way.
 * "Qamar | قمر — Dresses" (3 Arabic letters of 15) is an English title with the brand's Arabic name and is kept;
 * "متجر الأمل Amal" (9 of 13) is Arabic in the wrong field. Text with no letters at all is not Arabic.
 */
export function isMostlyArabic(value: string): boolean {
  const letters = value.match(LETTER) ?? [];
  if (letters.length === 0) return false;
  const arabic = letters.filter(ch => ARABIC_LETTER.test(ch)).length;
  return arabic * 2 > letters.length;
}

/** The English-language fields of the SEO form (each has an Arabic twin). */
export const ENGLISH_SEO_FIELDS = ['metaTitle', 'metaDescription', 'metaDescriptionAeo'] as const;
export type EnglishSeoField = (typeof ENGLISH_SEO_FIELDS)[number];

/**
 * English fields written in Arabic (`isMostlyArabic`), in form order. Empty = the form is fine. An English title that
 * only names the brand in Arabic is English and passes.
 */
export function arabicInEnglishFields(
  values: Partial<Record<EnglishSeoField, string>>
): EnglishSeoField[] {
  return ENGLISH_SEO_FIELDS.filter(key => isMostlyArabic(values[key] ?? ''));
}

/**
 * One English/Arabic pair from the AI. An English slot written in Arabic (`isMostlyArabic`) next to an Arabic slot
 * that is not = swapped, so swap them back. Anything still on the wrong side after that is dropped (empty) rather
 * than saved in the wrong language: an English slot that is still mostly Arabic, or an Arabic slot with no Arabic
 * at all. An English title that carries the brand's Arabic name is English and is kept whole.
 */
export function normalizeLanguagePair(
  en: string,
  ar: string
): { en: string; ar: string; swapped: boolean } {
  let a = en.trim();
  let b = ar.trim();
  let swapped = false;
  if (isMostlyArabic(a) && !isMostlyArabic(b)) {
    [a, b] = [b, a];
    swapped = true;
  }
  if (isMostlyArabic(a)) a = '';
  if (b !== '' && !hasArabicScript(b)) b = '';
  return { en: a, ar: b, swapped };
}

/** The four SEO meta fields an `/ai/seo` answer fills (store, category and product forms share the names). */
export interface SeoMetaFields {
  metaTitle?: string;
  metaTitleAr?: string;
  metaDescription?: string;
  metaDescriptionAr?: string;
}

/**
 * QA P2-2: every `/ai/seo` caller applies the AI answer through here, so Arabic never lands in an English field on
 * ANY form (the store SEO page had the guard; the product and category forms copied the answer straight in). Each
 * pair goes through `normalizeLanguagePair`; `fill-empty` touches only empty fields, a value dropped as wrong-language
 * leaves the field as it was. Returns the next fields and the names of the fields it filled.
 */
export function applyAiSeoSuggestion<T extends SeoMetaFields>(
  prev: T,
  s: { title: string; titleAr: string; description: string; descriptionAr: string },
  mode: 'fill-empty' | 'overwrite'
): { next: T; filled: Array<keyof SeoMetaFields> } {
  const title = normalizeLanguagePair(s.title ?? '', s.titleAr ?? '');
  const description = normalizeLanguagePair(s.description ?? '', s.descriptionAr ?? '');
  const targets: Array<[keyof SeoMetaFields, string]> = [
    ['metaTitle', title.en],
    ['metaTitleAr', title.ar],
    ['metaDescription', description.en],
    ['metaDescriptionAr', description.ar],
  ];
  const next = { ...prev };
  const filled: Array<keyof SeoMetaFields> = [];
  for (const [field, value] of targets) {
    if (value === '') continue;
    if (mode === 'overwrite' || !prev[field]) {
      next[field] = value as T[keyof SeoMetaFields];
      filled.push(field);
    }
  }
  return { next, filled };
}

/** One English/Arabic text pair (the product AEO answer) with the same rule: swapped back, wrong-language dropped. */
export function applyAiLanguagePair(
  prevEn: string | undefined,
  prevAr: string | undefined,
  en: string,
  ar: string,
  mode: 'fill-empty' | 'overwrite'
): { en: string; ar: string } {
  const pair = normalizeLanguagePair(en ?? '', ar ?? '');
  const pick = (prev: string | undefined, value: string) =>
    value !== '' && (mode === 'overwrite' || !prev) ? value : (prev ?? '');
  return { en: pick(prevEn, pair.en), ar: pick(prevAr, pair.ar) };
}
