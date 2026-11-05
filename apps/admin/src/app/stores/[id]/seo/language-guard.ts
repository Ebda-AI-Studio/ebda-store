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
