/**
 * Per-tenant date/time formatting.
 *
 * The storefront is multi-tenant: an Egypt beauty brand and a UAE retailer
 * can both run on the same Vercel deployment but should render dates using
 * their own timezone (`store.timezone`) and the visitor's preferred locale
 * (`useLanguage().language`). Every call site that previously hardcoded
 * `'en-US'` or relied on the visitor's browser timezone now goes through
 * these helpers so we get consistent, tenant-correct output.
 *
 * Why three style presets instead of accepting raw `Intl.DateTimeFormatOptions`?
 * Keeps formatting decisions in one file — designers can tweak "long" once
 * and every PDP / order page picks it up. Call sites that need something
 * truly bespoke can still drop down to `Intl.DateTimeFormat` directly, but
 * that should be rare.
 */
import { intlLocale, type Numerals } from '@ebda/shared';

export type FormatDateStyle = 'short' | 'medium' | 'long' | 'datetime' | 'day';

export interface FormatDateOptions {
  /** Store IANA timezone (e.g. 'Africa/Cairo'). Falls back to Africa/Cairo. */
  timezone?: string;
  /** Visitor language. Falls back to 'en'. */
  language?: 'en' | 'ar';
  /** Visual preset. Default: 'long'. */
  style?: FormatDateStyle;
  /** Digit system (Ruling NUMERALS-1): Western by default in both languages;
   *  pass `useStoreNumerals()` so an opted-in store's Arabic readers get ٠-٩. */
  numerals?: Numerals;
}

const DEFAULT_TIMEZONE = 'Africa/Cairo';

/**
 * Map the storefront's `'en' | 'ar'` language to the BCP-47 tag we hand to
 * `Intl.DateTimeFormat`, with the digit system pinned: Arabic visitors get
 * Arabic month names with WESTERN digits (`ar-EG-u-nu-latn`) unless the store
 * opted into Arabic-Indic digits. Bare `ar-EG` defaults to ٠-٩ on every CLDR.
 */
function resolveLocale(
  language: FormatDateOptions['language'],
  numerals: FormatDateOptions['numerals']
): string {
  return intlLocale(language ?? 'en', numerals ?? 'latn');
}

function presetOptions(style: FormatDateStyle): Intl.DateTimeFormatOptions {
  switch (style) {
    case 'short':
      return { year: 'numeric', month: 'numeric', day: 'numeric' };
    case 'medium':
      // "15 Oct 2026" / "١٥ أكتوبر ٢٠٢٦": no month-first numeric date for an Egyptian
      // reader. Parts are re-joined day month year (see `format`).
      return { day: 'numeric', month: 'short', year: 'numeric' };
    case 'day':
      // No year, e.g. "Wed 21 Oct" / "الأربعاء ٢١ أكتوبر": for near-term dates like a delivery
      // window. Parts are re-joined weekday day month (see `format`), so no locale comma.
      return { weekday: 'short', day: 'numeric', month: 'short' };
    case 'datetime':
      return {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      };
    case 'long':
    default:
      return { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' };
  }
}

function toDate(input: string | number | Date): Date | null {
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Format a date using the store's timezone and the visitor's language.
 * Returns an empty string for invalid inputs so call sites can render
 * the result directly without guarding for NaN dates.
 */
export function formatDate(input: string | number | Date, opts: FormatDateOptions = {}): string {
  const date = toDate(input);
  if (!date) return '';

  const locale = resolveLocale(opts.language, opts.numerals);
  const style = opts.style ?? 'long';
  const format = (timeZone: string): string => {
    const dtf = new Intl.DateTimeFormat(locale, {
      ...presetOptions(style),
      timeZone,
      numberingSystem: 'latn', // Western digits always (DIGITS-1)
    });
    if (style !== 'day' && style !== 'medium') return dtf.format(date);
    // Fixed weekday-day-month (or day-month-year) order with single spaces: en-US would
    // say "Wed, Oct 21" / "Oct 15, 2026".
    const parts = dtf.formatToParts(date);
    const order =
      style === 'day'
        ? (['weekday', 'day', 'month'] as const)
        : (['day', 'month', 'year'] as const);
    return order
      .map(t => parts.find(p => p.type === t)?.value)
      .filter(Boolean)
      .join(' ');
  };

  try {
    return format(opts.timezone || DEFAULT_TIMEZONE);
  } catch {
    // An invalid IANA zone (typo in admin settings) would otherwise crash
    // every page that renders a date. Fall back silently to the default.
    return format(DEFAULT_TIMEZONE);
  }
}

/**
 * Convenience wrapper that always uses the `datetime` preset. Most callers
 * want either `formatDate(d, opts)` (date only) or `formatDateTime(d, opts)`
 * (date + time) — the explicit name reads better than `style: 'datetime'`.
 */
export function formatDateTime(
  input: string | number | Date,
  opts: Omit<FormatDateOptions, 'style'> = {}
): string {
  return formatDate(input, { ...opts, style: 'datetime' });
}
