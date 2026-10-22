/**
 * The label of a store tag in the shopper's language (Phase B3 fix wave 1, Ruling B3-13).
 * `name` is the canonical (English) label and the filter key; `nameAr` the Arabic one. An Arabic
 * page shows `nameAr` and falls back to `name`; an English page shows `name` (a legacy tag whose
 * `name` is Arabic and has no Arabic twin is still shown rather than hidden). When the text shown
 * is in the OTHER language than the page, `lang` names it (WCAG 3.1.2), otherwise it is undefined.
 */
export interface TagLabelSource {
  name: string;
  nameAr?: string | null;
}

const ARABIC = /[؀-ۿ]/;

export function tagLabel(
  tag: TagLabelSource,
  language: 'ar' | 'en'
): { text: string; lang: 'ar' | 'en' | undefined } {
  const ar = (tag.nameAr ?? '').trim();
  const text = language === 'ar' ? ar || tag.name : tag.name || ar;
  const textLang: 'ar' | 'en' = ARABIC.test(text) ? 'ar' : 'en';
  return { text, lang: textLang === language ? undefined : textLang };
}
