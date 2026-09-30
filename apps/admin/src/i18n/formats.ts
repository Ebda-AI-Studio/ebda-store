/**
 * Admin-wide ICU formats (issue 1971).
 *
 * next-intl formats a plural `#` and a `{n, number}` argument through
 * `Intl.NumberFormat(locale)`. For `ar` the default numbering system depends on
 * the browser's CLDR (older data: Arabic-Indic `٤٢`; CLDR 48: Latin), while
 * everything the admin formats itself — prices, dates, raw `{count}` values,
 * table cells — is Latin. That mixed two digit systems inside one label.
 *
 * Policy: the admin renders Latin digits in both locales. Every catalogue
 * number argument therefore uses the named `latn` style —
 * `{count, number, latn}` — instead of `#` or a bare `{count, number}`
 * (pinned by tests/unit/admin-i18n-latin-digits.test.ts). A plain `{count}`
 * is already Latin: ICU stringifies it without a formatter.
 */
export const intlFormats = {
  number: {
    latn: { numberingSystem: 'latn' },
  },
};
