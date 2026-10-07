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
import { intlLocale, type Numerals } from '@force/shared';

export type FormatDateStyle = 'short' | 'long' | 'datetime';

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
  const timeZone = opts.timezone || DEFAULT_TIMEZONE;
  const options: Intl.DateTimeFormatOptions = {
    ...presetOptions(opts.style ?? 'long'),
    timeZone,
  };

  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    // An invalid IANA zone (typo in admin settings) would otherwise crash
    // every page that renders a date. Fall back silently to the default.
    return new Intl.DateTimeFormat(locale, {
      ...presetOptions(opts.style ?? 'long'),
      timeZone: DEFAULT_TIMEZONE,
    }).format(date);
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
