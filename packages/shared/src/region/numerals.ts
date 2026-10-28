/**
 * Digit policy: ONE helper for every number, price and date Ebda renders.
 *
 * Ruling DIGITS-1 (Ahmad, 2026-10-26; it supersedes NUMERALS-1's per-store opt-in): Western digits (0-9) in
 * EVERY Ebda surface, in Arabic AND English: storefront, admin, orders, marketing, help, docs, status, accounts,
 * emails, notifications, invoices, receipts, packing slips, labels. Arabic-Indic digits are never produced.
 * A store theme that still carries `arabicNumerals: true` (the retired opt-in) is ignored.
 *
 * Why an explicit numbering system on every Intl call: `ar-EG` (and the browser's own default locale on an
 * Arabic phone) default to Arabic-Indic digits on older CLDR, so "no option" silently means ٤٥٠ for a lot of
 * Egyptian visitors and merchants. Use `intlLocale()` / `withNumerals()`; tests/unit/digits-1-western-only.test.ts
 * fails any `ar` locale used without `-u-nu-latn`.
 */

/** A rendering's digit system, as Intl names it. */
export type Numerals = 'latn';

/** The store's digit system: Western, always (DIGITS-1). The retired `arabicNumerals` theme flag is ignored. */
export function storeNumerals(_theme?: { arabicNumerals?: unknown } | null): Numerals {
  return 'latn';
}

/** The digits one render uses: Western, always (DIGITS-1). */
export function effectiveNumerals(_language?: string | null, _numerals?: Numerals): Numerals {
  return 'latn';
}

function isArabic(language: string | null | undefined): boolean {
  return typeof language === 'string' && /^ar(\b|[-_])/i.test(language);
}

/**
 * BCP-47 tag for `Intl.*` / `toLocale*String` with the numbering system
 * pinned: `ar-EG-u-nu-latn` or `en-US-u-nu-latn` (Ruling DIGITS-1).
 */
export function intlLocale(
  language: string | null | undefined,
  numerals: Numerals = 'latn'
): string {
  const base = isArabic(language) ? 'ar-EG' : 'en-US';
  return `${base}-u-nu-${effectiveNumerals(language, numerals)}`;
}

/**
 * Add the numbering system to a set of Intl options. For call sites that keep
 * their own locale (or `undefined` = the runtime's): `d.toLocaleString(undefined, withNumerals())`.
 * An explicit `numberingSystem` option wins over a locale's `-u-nu-` extension.
 */
/** Every option `Intl.NumberFormat` / `Intl.DateTimeFormat` accept (and `toLocale*String`). */
export type IntlFormatOptions = Intl.NumberFormatOptions & Intl.DateTimeFormatOptions;

export function withNumerals(options?: IntlFormatOptions, _numerals?: Numerals): IntlFormatOptions {
  return { ...options, numberingSystem: 'latn' };
}

/** Kept for call-site compatibility: digits are never swapped (DIGITS-1), the input is returned as text. */
export function localizeDigits(input: string | number, _numerals?: Numerals): string {
  return String(input);
}

/** A plain count/quantity (`1,234`), grouped, in the chosen digits. */
export function formatCount(
  value: number,
  language: string | null | undefined = 'en',
  numerals: Numerals = 'latn',
  options?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(intlLocale(language, numerals), options).format(value);
}

/** A date (or date-time) in the reader's language with the digit system pinned. */
export function formatDateIntl(
  input: string | number | Date,
  language: string | null | undefined = 'en',
  options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' },
  numerals: Numerals = 'latn'
): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(intlLocale(language, numerals), options).format(date);
}
