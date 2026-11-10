/**
 * SEO language guard (UX:SEO-4, QA P2-1): Arabic text must not land in an English field. The AI sometimes answers
 * with the languages swapped, and a merchant can paste Arabic into the English title. Search results then show the
 * wrong language to the wrong visitors, so the page swaps what is clearly swapped and refuses the rest, naming
 * the fields.
 */

const ARABIC_SCRIPT = /[؀-ۿݐ-ݿࢠ-ࣿ]/;

export function hasArabicScript(value: string): boolean {
  return ARABIC_SCRIPT.test(value);
}

/** The English-language fields of the SEO form (each has an Arabic twin). */
export const ENGLISH_SEO_FIELDS = ['metaTitle', 'metaDescription', 'metaDescriptionAeo'] as const;
export type EnglishSeoField = (typeof ENGLISH_SEO_FIELDS)[number];

/** English fields that contain Arabic letters, in form order. Empty = the form is fine. */
export function arabicInEnglishFields(
  values: Partial<Record<EnglishSeoField, string>>
): EnglishSeoField[] {
  return ENGLISH_SEO_FIELDS.filter(key => hasArabicScript(values[key] ?? ''));
}

/**
 * One English/Arabic pair from the AI. Arabic in the English slot with a non-Arabic Arabic slot = swapped, so swap
 * them back. Anything still on the wrong side after that is dropped (empty) rather than saved in the wrong language.
 */
export function normalizeLanguagePair(
  en: string,
  ar: string
): { en: string; ar: string; swapped: boolean } {
  let a = en.trim();
  let b = ar.trim();
  let swapped = false;
  if (hasArabicScript(a) && !hasArabicScript(b)) {
    [a, b] = [b, a];
    swapped = true;
  }
  if (hasArabicScript(a)) a = '';
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
