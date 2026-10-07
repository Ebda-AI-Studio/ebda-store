/**
 * Digit policy — ONE helper for every number, price and date Ebda renders
 * (Ahmad 2026-10-07, Ruling NUMERALS-1).
 *
 *  - Western digits (0-9) are the default everywhere, in Arabic AND English:
 *    storefront, emails, invoices, admin, orders app, help.
 *  - A store may opt into Arabic-Indic digits (٠-٩) for its CUSTOMER-FACING
 *    output only (`StoreTheme.arabicNumerals`, admin: Branding → Theme →
 *    "شكل الأرقام في المتجر"). It applies only while the shopper reads Arabic;
 *    English output and every merchant surface stay Western.
 *  - Identifiers (order numbers, SKUs, phones, tracking numbers) are never
 *    localized.
 *
 * Why an explicit numbering system on every Intl call: `ar-EG` (and the
 * browser's own default locale on an Arabic phone) default to Arabic-Indic
 * digits on every CLDR version, so "no option" silently means ٤٥٠ for a lot
 * of Egyptian visitors and merchants.
 */

/** A rendering's digit system, as Intl names it. */
export type Numerals = 'latn' | 'arab';

const ARAB_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

/**
 * The store's customer-facing digit choice. Western unless the merchant
 * explicitly opted in (`theme.arabicNumerals === true`); anything else —
 * unset, null, a malformed theme — is Western.
 */
export function storeNumerals(theme: { arabicNumerals?: unknown } | null | undefined): Numerals {
  return theme?.arabicNumerals === true ? 'arab' : 'latn';
}

/** The digits one render actually uses: Arabic-Indic only for an Arabic reader of an opted-in store. */
export function effectiveNumerals(
  language: string | null | undefined,
  numerals: Numerals = 'latn'
): Numerals {
  return numerals === 'arab' && isArabic(language) ? 'arab' : 'latn';
}

function isArabic(language: string | null | undefined): boolean {
  return typeof language === 'string' && /^ar(\b|[-_])/i.test(language);
}

/**
 * BCP-47 tag for `Intl.*` / `toLocale*String` with the numbering system
 * pinned: `ar-EG-u-nu-latn` (default), `ar-EG-u-nu-arab` (opted-in store,
 * Arabic reader), `en-US-u-nu-latn`.
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

export function withNumerals(
  options?: IntlFormatOptions,
  numerals: Numerals = 'latn'
): IntlFormatOptions {
  return { ...options, numberingSystem: numerals };
}

/** Swap ASCII digits for the chosen system; Western output is the input unchanged. */
export function localizeDigits(input: string | number, numerals: Numerals = 'latn'): string {
  const s = String(input);
  return numerals === 'arab' ? s.replace(/[0-9]/g, d => ARAB_DIGITS[Number(d)]) : s;
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
