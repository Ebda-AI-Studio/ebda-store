/**
 * A product's name pair (`name` = English, `nameAr` = Arabic) from whatever the client sent (Ruling NAME-PAIR-1).
 *
 * 2026-11-10: the quick-create form sent an Arabic-only name in `name` (so /en showed Arabic), and onboarding sent the
 * Arabic name as `name`, so the autofill "translated" it EN -> AR and stored the English "Sign Ring" in `nameAr`
 * (a swapped pair). The API now takes the name in either language:
 *   - `nameEn` is an alias of `name`; `sourceLang` says which language a lone `name` was typed in;
 *   - Arabic-script text in the English field (with no Arabic name) is the Arabic name;
 *   - an English-only text in `nameAr` with Arabic in `name` is a swapped pair and is put right.
 * When only the Arabic name is known, `name` (NOT NULL) holds the same text as a PLACEHOLDER: the autofill treats
 * `name === nameAr` as a gap and translates into it (`isNamePlaceholder`), never over a typed name.
 */
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿ]/;
const LATIN = /[A-Za-z]/;

/** Arabic letters and no Latin letters (digits/punctuation ignored). */
export const isArabicText = (s: string | null | undefined): boolean =>
  !!s && ARABIC.test(s) && !LATIN.test(s);
/** Latin letters and no Arabic letters. */
export const isLatinText = (s: string | null | undefined): boolean =>
  !!s && LATIN.test(s) && !ARABIC.test(s);

export interface NameInput {
  name?: string | null;
  nameEn?: string | null;
  nameAr?: string | null;
  sourceLang?: 'ar' | 'en';
}

export interface NamePair {
  /** undefined = leave the stored value alone (update). */
  name?: string;
  nameAr?: string | null;
  /** `name` is a copy of `nameAr`, waiting for its translation (never stamped as typed by the merchant). */
  namePlaceholder: boolean;
}

const clean = (s: string | null | undefined): string | null | undefined =>
  s === undefined ? undefined : s === null ? null : s.trim() || null;

/**
 * `op: 'update'` never invents an English name: an update that sends only `nameAr` leaves the stored `name` alone.
 */
export function resolveNamePair(input: NameInput, op: 'create' | 'update' = 'create'): NamePair {
  const enSent = clean(input.nameEn ?? input.name);
  let en = clean(input.nameEn ?? input.name);
  let ar = clean(input.nameAr);
  // A lone name typed in Arabic, said so or written so, is the Arabic name.
  if (en && !ar && (input.sourceLang === 'ar' || (input.sourceLang !== 'en' && isArabicText(en)))) {
    ar = en;
  } else if (en && ar && isArabicText(en) && isLatinText(ar)) {
    [en, ar] = [ar, en]; // swapped pair
  }
  if (ar && (en === ar || (!en && (op === 'create' || !!enSent))))
    return { name: ar, nameAr: ar, namePlaceholder: true };
  return {
    ...(en ? { name: en } : {}),
    ...(ar !== undefined ? { nameAr: ar } : {}),
    namePlaceholder: false,
  };
}

/** `name` is the untranslated copy of `nameAr` (see resolveNamePair), so the autofill may fill it. */
export const isNamePlaceholder = (row: { name?: string | null; nameAr?: string | null }): boolean =>
  !!row.name && !!row.nameAr && row.name.trim() === row.nameAr.trim();
