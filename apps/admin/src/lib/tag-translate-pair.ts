/**
 * Tags created before `nameAr` existed carry their ARABIC text in `name` (the English slot).
 * "Translate missing" must not send that text as `from: 'en'`: the translator would be told Arabic
 * is English. The pair is built by the script of `name`: an Arabic `name` with an empty `nameAr`
 * is presented as an Arabic-only row, so the button translates ar -> en, the English result
 * becomes `name` and the original Arabic moves into `nameAr` (Ruling B3-13).
 */
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿ]/;
const LATIN = /[A-Za-z]/;

/** True when the text is written mainly in Arabic script (no Latin letters, at least one Arabic). */
export function isArabicScript(text: string): boolean {
  return ARABIC.test(text) && !LATIN.test(text);
}

export interface TagTranslateRow {
  id: string;
  name: string;
  nameAr: string;
}

export interface TagTranslatePair {
  key: string;
  en: string;
  ar: string;
  kind: 'category-name';
  onEnFilled: (value: string) => void;
  onArFilled: (value: string) => void;
}

export function tagTranslatePair(
  row: TagTranslateRow,
  patch: (id: string, change: Partial<TagTranslateRow>) => void
): TagTranslatePair {
  const legacyArabic = row.nameAr.trim() === '' && isArabicScript(row.name);
  return {
    key: row.id,
    en: legacyArabic ? '' : row.name,
    ar: legacyArabic ? row.name : row.nameAr,
    kind: 'category-name',
    // the English answer for a legacy Arabic `name`: keep the Arabic as `nameAr`
    onEnFilled: v => patch(row.id, legacyArabic ? { name: v, nameAr: row.name } : { name: v }),
    onArFilled: v => patch(row.id, { nameAr: v }),
  };
}
