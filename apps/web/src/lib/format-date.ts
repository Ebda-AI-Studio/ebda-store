/**
 * Per-tenant date/time formatting.
 *
 * The storefront is multi-tenant: a Kuwait beauty brand and a UAE retailer
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
export type FormatDateStyle = 'short' | 'long' | 'datetime';

export interface FormatDateOptions {
  /** Store IANA timezone (e.g. 'Asia/Kuwait'). Falls back to Asia/Kuwait. */
  timezone?: string;
  /** Visitor language. Falls back to 'en'. */
  language?: 'en' | 'ar';
  /** Visual preset. Default: 'long'. */
  style?: FormatDateStyle;
}

const DEFAULT_TIMEZONE = 'Asia/Kuwait';

/**
 * Map the storefront's `'en' | 'ar'` language to the BCP-47 tag we hand to
 * `Intl.DateTimeFormat`. Arabic visitors get Arabic-Kuwait formatting (so
 * digits and month names render in Arabic) — same convention `formatPrice`
 * already uses elsewhere.
 */
function resolveLocale(language: FormatDateOptions['language']): string {
  return language === 'ar' ? 'ar-KW' : 'en-US';
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

  const locale = resolveLocale(opts.language);
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
