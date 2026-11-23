/**
 * AI-written text is stored in both languages (`xEn` / `xAr`). The admin shows ONE: the admin's own language,
 * falling back to the other only when that side is empty (an older row, or a failed Arabic pass). Never both
 * stacked, never the English side in an Arabic UI or the Arabic side in an English one.
 */
export function pickAiText(
  locale: string,
  en: string | null | undefined,
  ar: string | null | undefined
): { text: string; lang: 'en' | 'ar' } {
  const e = en?.trim() ?? '';
  const a = ar?.trim() ?? '';
  if (locale === 'ar') return a ? { text: a, lang: 'ar' } : { text: e, lang: 'en' };
  return e ? { text: e, lang: 'en' } : { text: a, lang: 'ar' };
}
