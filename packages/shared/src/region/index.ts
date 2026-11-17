/**
 * Region configuration + money helpers for Ebda (Egypt).
 *
 * This module is the ONE place that knows the country, currency, minor-unit
 * scale, default VAT, locale, timezone, phone shape and governorates. Nothing
 * else in the codebase may hard-code `100` / `1000` as a currency scale or a
 * currency literal for display — read `REGION`, or call `currencyExponent()`.
 *
 * MONEY RULES (see CLAUDE.md / docs RULINGS):
 *  - Money is an integer in MINOR units (EGP: 1 EGP = 100 piastres). Never a
 *    float, never a decimal string, in storage or in arithmetic.
 *  - VAT is charged AFTER discount: `vat = round(max(0, subtotal - discount) * rate)`.
 *  - ROUNDING RULE: round HALF UP to the minor unit (0.5 piastre -> 1). This is
 *    the rule Ebda already used everywhere (`Math.round` on non-negative values);
 *    it is kept so VAT, percentage discounts and refund proration stay
 *    byte-identical to Ebda except for the scale. All of it is done in integer
 *    arithmetic (`mulDivRound`) — no float multiplication of a rate.
 *  - Legacy naming: identifiers/columns spelled `*Fils` / `*_fils` in this repo
 *    are MINOR units (they were fils in Ebda); they were not renamed because the
 *    DB columns would need a rename migration. They are piastres in Ebda.
 */

import { EGYPT_GOVERNORATE_LIST, type Governorate } from './governorates';
import { zonedDayStart, zonedIsoDay } from '../schemas/report-range';
import type { Numerals } from './numerals';

export * from './numerals';

export { EGYPT_GOVERNORATE_LIST };
export type { Governorate };

// ─── Currency exponent (the single source of the minor-unit scale) ──────────

const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  EGP: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  SAR: 2,
  AED: 2,
  QAR: 2,
  TRY: 2,
  INR: 2,
  CNY: 2,
  BHD: 3,
  OMR: 3,
  JOD: 3,
  JPY: 0,
};

/**
 * Number of decimal places of a currency's minor unit (EGP 2, BHD 3, USD 2,
 * JPY 0). Unknown codes default to 2 (the ISO-4217 majority). This is the ONLY
 * place a scale is derived — everything else calls this.
 */
export function currencyExponent(code: string): number {
  return CURRENCY_EXPONENTS[String(code).toUpperCase()] ?? 2;
}

/** Minor units in one major unit of `code` (EGP 100, BHD 1000). */
export function minorUnitsPerMajor(code: string = 'EGP'): number {
  return 10 ** currencyExponent(code);
}

// ─── REGION ──────────────────────────────────────────────────────────────────

export interface RegionConfig {
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** Country display names — the value stored in `Address.country` / `ShippingAreaRate.country`. */
  countryName: { en: string; ar: string };
  /** ISO-4217 base currency. Typed `string` (not the literal) so it can default any `currency: string` parameter. */
  currency: string;
  minorUnitsPerMajor: number;
  currencyDecimals: number;
  currencySymbol: { ar: string; en: string };
  defaultVatBps: number;
  defaultLocale: string;
  timezone: string;
  phone: {
    callingCode: string;
    trunkPrefix: string;
    mobilePrefixes: readonly string[];
    mobileNationalLength: number;
    mobileLocalLength: number;
    mobileRegex: RegExp;
    placeholder: string;
    placeholderIntl: string;
  };
  governorates: readonly Governorate[];
}

export const REGION: RegionConfig = {
  country: 'EG',
  countryName: { en: 'Egypt', ar: 'مصر' },
  currency: 'EGP',
  minorUnitsPerMajor: minorUnitsPerMajor('EGP'),
  currencyDecimals: currencyExponent('EGP'),
  currencySymbol: { ar: 'ج.م', en: 'EGP' },
  /** Default VAT in basis points (14%). Configurable per store. */
  defaultVatBps: 1400,
  defaultLocale: 'ar',
  timezone: 'Africa/Cairo',
  phone: {
    /** E.164 country calling code. */
    callingCode: '+20',
    /** Trunk prefix dialled domestically (01012345678). */
    trunkPrefix: '0',
    /** Mobile prefixes (after the trunk 0): Vodafone 10, Etisalat 11, Orange 12, WE 15. */
    mobilePrefixes: ['10', '11', '12', '15'],
    /** Digits of a mobile number after the trunk 0 / calling code. */
    mobileNationalLength: 10,
    /** Digits of a mobile number as dialled domestically, including the 0. */
    mobileLocalLength: 11,
    /** Domestic (01xxxxxxxxx) or international (+20 1xxxxxxxxx) mobile, Latin digits. */
    mobileRegex: /^(?:\+?20|0020|0)?1[0125]\d{8}$/,
    placeholder: '01012345678',
    placeholderIntl: '+201012345678',
  },
  governorates: EGYPT_GOVERNORATE_LIST,
};

export type RegionLocale = 'ar' | 'en';

// ─── Integer math ────────────────────────────────────────────────────────────

/** Exact `floor(x / y)` for non-negative safe integers (no float-division edge cases). */
function floorDiv(x: number, y: number): number {
  return (x - (x % y)) / y;
}

/**
 * `round(amount * numerator / denominator)` in exact integer arithmetic,
 * rounding HALF UP (away from zero for negatives, so f(-x) = -f(x)).
 * The product must stay a safe integer (|amount| * |numerator| < 2^53 / 2);
 * for minor-unit amounts and basis points that is any order below ~900 million EGP.
 */
export function mulDivRound(amount: number, numerator: number, denominator: number): number {
  if (!Number.isInteger(amount) || !Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new RangeError('mulDivRound requires integer arguments');
  }
  if (denominator <= 0) throw new RangeError('mulDivRound requires a positive denominator');
  const neg = amount !== 0 && numerator !== 0 && amount < 0 !== numerator < 0;
  const product = Math.abs(amount) * Math.abs(numerator);
  if (!Number.isSafeInteger(product * 2 + denominator)) {
    throw new RangeError('mulDivRound overflow: amount * numerator exceeds the safe integer range');
  }
  const q = floorDiv(product * 2 + denominator, denominator * 2); // floor((2p + d) / 2d) == round half up
  return neg ? -q : q;
}

/** `bps` basis points (1 bp = 0.01%) of `amountMinor`, rounded half up to the minor unit. */
export function percentOfMinor(amountMinor: number, bps: number): number {
  return mulDivRound(amountMinor, bps, 10_000);
}

/**
 * VAT on an order, charged AFTER discount. The taxable base is
 * `max(0, subtotal - discount) + charges` (shipping + COD fee the seller
 * bills). Rounded half up to the minor unit.
 *
 * `includedInPrice` selects EXTRACTION: the listed prices already contain the
 * tax, so the tax portion is `base * bps / (10000 + bps)` (the caller must not
 * add it on top again).
 */
export function vatOnDiscounted(
  subtotalMinor: number,
  discountMinor: number,
  vatBps: number,
  includedInPrice = false,
  chargesMinor = 0
): number {
  // `chargesMinor` = the seller's own charges on the same supply (shipping it
  // bills, the COD fee): part of the taxable value under VAT Law 67/2016
  // Art. 10(2) (ruling MONEYB-2), taxed at the goods' rate, never discounted.
  const base = Math.max(0, subtotalMinor - discountMinor) + Math.max(0, chargesMinor);
  if (includedInPrice) return mulDivRound(base, vatBps, 10_000 + vatBps);
  return mulDivRound(base, vatBps, 10_000);
}

/**
 * Cash-on-delivery fee. `fixedMinor` plus an optional percentage of the order
 * total (`percentBps`), the percentage rounded half up. Result is never negative.
 */
export function codFeeMinor(
  orderTotalMinor: number,
  opts: { fixedMinor?: number; percentBps?: number } = {}
): number {
  const fixed = opts.fixedMinor ?? 0;
  const pct = opts.percentBps ? percentOfMinor(orderTotalMinor, opts.percentBps) : 0;
  return Math.max(0, fixed + pct);
}

// ─── major <-> minor ─────────────────────────────────────────────────────────

/** Normalise Eastern Arabic-Indic (٠-٩), Persian (۰-۹) digits and the Arabic decimal/thousands separators to ASCII. */
function normalizeNumeric(input: string): string {
  return input
    .trim()
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/٬/g, '');
}

/**
 * Parse a merchant/customer-typed MAJOR amount into integer minor units WITHOUT
 * floating-point math (`parseFloat('0.29') * 100` is 28.999…). Returns `null`
 * for anything that is not a plain decimal or that has more fractional digits
 * than the currency allows (`'1.999'` → null for EGP). Trailing zeros beyond
 * the exponent are accepted (`'1.500'` → 150) because they lose nothing.
 */
export function tryToMinor(
  major: string | number,
  currency: string = REGION.currency
): number | null {
  const exp = currencyExponent(currency);
  const scale = 10 ** exp;
  if (typeof major === 'number') {
    if (!Number.isFinite(major)) return null;
    const scaled = major * scale;
    const rounded = Math.round(scaled);
    // Tolerate binary float noise (1.1*100 = 110.00000000000001) but not a real extra digit.
    if (Math.abs(scaled - rounded) > 1e-6 * Math.max(1, Math.abs(rounded))) return null;
    return Number.isSafeInteger(rounded) ? rounded : null;
  }
  const s = normalizeNumeric(String(major));
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return null;
  const [, sign, whole = '', fracRaw = ''] = m;
  if (whole === '' && fracRaw === '') return null;
  const frac = fracRaw.replace(/0+$/, '');
  if (frac.length > exp) return null;
  const minorStr = `${whole || '0'}${frac.padEnd(exp, '0')}`;
  const n = Number(minorStr);
  if (!Number.isSafeInteger(n)) return null;
  return sign === '-' && n !== 0 ? -n : n;
}

/**
 * Strict `tryToMinor`: throws a `RangeError` on malformed input or too many
 * decimals. `toMinor('199.99')` → 19999; `toMinor('1.999')` throws.
 */
export function toMinor(major: string | number, currency: string = REGION.currency): number {
  const n = tryToMinor(major, currency);
  if (n === null) {
    throw new RangeError(
      `Invalid ${currency} amount "${String(major)}": expected a number with at most ${currencyExponent(currency)} decimals`
    );
  }
  return n;
}

/**
 * Lenient float → minor conversion for already-validated UI math (sliders,
 * derived percentages): rounds half up to the minor unit. NOT for parsing user
 * text — use `tryToMinor`.
 */
export function roundToMinor(major: number, currency: string = REGION.currency): number {
  const exp = currencyExponent(currency);
  // Shift the decimal point with exponent notation (`'1.005e2'` parses to exactly
  // 100.5) instead of `1.005 * 100` (= 100.49999999999999), so half-up rounding
  // is decimal-correct. Falls back to multiplication for values already in
  // exponent notation (|x| < 1e-6 or >= 1e21).
  const text = String(major);
  const shifted = /e/i.test(text) ? major * 10 ** exp : Number(`${text}e${exp}`);
  const rounded = Math.round(Math.abs(shifted)); // half up, sign-symmetric (-x → -round(x))
  return shifted < 0 ? -rounded : rounded;
}

/** Minor units → major units as a number (`19999` → `199.99`). For display math / analytics only. */
export function fromMinor(minor: number, currency: string = REGION.currency): number {
  return minor / minorUnitsPerMajor(currency);
}

/**
 * Minor units → fixed-decimal string using integer math (`19999` → `"199.99"`,
 * `5` → `"0.05"`). Use for `<input value>` fields, CSV export, JSON-LD and
 * provider payloads that need a plain decimal.
 */
export function minorToDecimalString(minor: number, currency: string = REGION.currency): string {
  const exp = currencyExponent(currency);
  const neg = minor < 0;
  const abs = Math.abs(Math.round(minor));
  if (exp === 0) return `${neg ? '-' : ''}${abs}`;
  const scale = 10 ** exp;
  const whole = Math.floor(abs / scale);
  const frac = String(abs % scale).padStart(exp, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

export interface FormatMoneyOptions {
  /** Ignored: Western digits only, in both locales (Ruling DIGITS-1). Kept so callers keep compiling. */
  numerals?: Numerals;
  /** @deprecated ignored (Ruling DIGITS-1). */
  easternArabicDigits?: boolean;
  /** Currency of `minor`. Default `REGION.currency`. */
  currency?: string;
  /** Omit the currency symbol/code. Default false. */
  hideSymbol?: boolean;
  /** Always print `currencyExponent` decimals (`450.00`). Default false: a
   *  whole amount drops its zero fraction (`450 ج.م`), an amount with
   *  piastres keeps every decimal (`450.50 ج.م`). */
  fixedDecimals?: boolean;
}

function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format a MINOR-unit amount for display. Deterministic (no ICU dependence):
 *  - en: `EGP 1,299.50`, `EGP 450`
 *  - ar: `1,299.50 ج.م`, `450 ج.م` — Western digits always (Ruling DIGITS-1).
 * A whole amount drops its all-zero fraction ("450 ج.م", not "450.00 ج.م");
 * an amount with a fractional part shows every decimal of the currency.
 */
export function formatMoney(
  minor: number,
  locale: RegionLocale = 'ar',
  opts: FormatMoneyOptions = {}
): string {
  const currency = opts.currency ?? REGION.currency;
  const plain = minorToDecimalString(minor, currency);
  const neg = plain.startsWith('-');
  const [whole, frac] = plain.replace('-', '').split('.');
  const keepFrac = frac !== undefined && (opts.fixedDecimals === true || /[1-9]/.test(frac));
  const num = groupThousands(whole) + (keepFrac ? `.${frac}` : '');
  // Western digits only (Ruling DIGITS-1): `numerals` / `easternArabicDigits` are accepted and ignored.
  const signed = neg && /[1-9]/.test(num) ? `-${num}` : num;
  if (opts.hideSymbol) return signed;
  const symbol =
    currency.toUpperCase() === REGION.currency
      ? REGION.currencySymbol[locale]
      : currency.toUpperCase();
  return locale === 'ar' ? `${signed} ${symbol}` : `${symbol} ${signed}`;
}

/**
 * Excel/XLSX number format for a money column holding MAJOR-unit numbers
 * (`1234.5` → `1,234.50`). Decimals come from `currencyExponent`, so a 2-decimal
 * currency never gets a hard-coded `.000`.
 */
export function excelMoneyFormat(opts: { grouped?: boolean; currency?: string } = {}): string {
  const exp = currencyExponent(opts.currency ?? REGION.currency);
  const int = opts.grouped ? '#,##0' : '0';
  return exp > 0 ? `${int}.${'0'.repeat(exp)}` : int;
}

// ─── Locale ──────────────────────────────────────────────────────────────────

/**
 * A store's language when its `settings.defaultLanguage` is `'ar'`, `'en'`, or
 * unset/garbage: an explicit `'en'` stays English, `'ar'` stays Arabic, and
 * everything else falls to `REGION.defaultLocale` (Arabic-first).
 */
export function resolveDefaultLanguage(raw: unknown): RegionLocale {
  if (raw === 'en' || raw === 'ar') return raw;
  return REGION.defaultLocale === 'en' ? 'en' : 'ar';
}

// ─── Phones ──────────────────────────────────────────────────────────────────

/**
 * Normalise an Egyptian mobile number to E.164 (`+201012345678`). Accepts
 * `01012345678`, `1012345678`, `+201012345678`, `00201012345678`,
 * `201012345678`, with spaces/dashes/parentheses and Eastern Arabic digits.
 * Returns `null` if it is not a valid Egyptian mobile (010/011/012/015 + 8 digits).
 */
export function normalizeEgyptianMobile(input: string): string | null {
  const digits = normalizeNumeric(String(input)).replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(digits)) return null;
  if (!REGION.phone.mobileRegex.test(digits)) return null;
  const national = digits.replace(/^(?:\+?20|0020|0)/, '');
  return `${REGION.phone.callingCode}${national}`;
}

/**
 * The phone as an order STORES it (ruling MONEYB-7): an Egyptian mobile in
 * E.164 (`+201012345678`) whatever the shopper typed (`٠١٠ ١٢٣٤ ٥٦٧٨`,
 * `0020…`, spaces, dashes); anything else (a landline, a foreign number) as
 * ASCII digits with its leading `+` kept, separators dropped. Empty stays
 * empty. wa.me links, couriers (Bosta wants Latin digits) and the guest-order
 * lookup all read this one form.
 */
export function normalizePhoneForStorage<T extends string | null | undefined>(input: T): T {
  if (input == null) return input;
  const trimmed = String(input).trim();
  if (!trimmed) return trimmed as T;
  const mobile = normalizeEgyptianMobile(trimmed);
  if (mobile) return mobile as T;
  return normalizeNumeric(trimmed).replace(/[\s\-().]/g, '') as T;
}

export function isValidEgyptianMobile(input: string): boolean {
  return normalizeEgyptianMobile(input) !== null;
}

/** `+201012345678` → `010 1234 5678` for display. Returns the input unchanged if not an EG mobile. */
export function formatEgyptianMobile(input: string): string {
  const e164 = normalizeEgyptianMobile(input);
  if (!e164) return input;
  const local = `0${e164.slice(REGION.phone.callingCode.length)}`;
  return `${local.slice(0, 3)} ${local.slice(3, 7)} ${local.slice(7)}`;
}

// ─── Governorates ────────────────────────────────────────────────────────────

export function findGovernorate(value: string | null | undefined): Governorate | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  return REGION.governorates.find(
    g => g.code.toLowerCase() === v || g.nameEn.toLowerCase() === v || g.nameAr === value.trim()
  );
}

// ─── Calendar days in the region's timezone ─────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The instant the calendar day containing `d` starts in `REGION.timezone`
 * (Africa/Cairo). DST-aware: Egypt observes DST (UTC+2 winter, UTC+3 summer),
 * so a fixed offset is wrong for half the year and a day is 23/24/25 hours.
 */
export function regionDayStart(d: Date = new Date(), timeZone: string = REGION.timezone): Date {
  return zonedDayStart(zonedIsoDay(d, timeZone), timeZone) as Date;
}

/** Start of the region day `n` days after the one containing `d` (`n` may be negative). */
export function regionDayStartOffset(d: Date, n: number, timeZone: string = REGION.timezone): Date {
  // Land at midday of the target day (±1h of DST shift can never cross midnight),
  // then snap to that day's start.
  const noon = regionDayStart(d, timeZone).getTime() + 12 * 60 * 60 * 1000 + n * DAY_MS;
  return regionDayStart(new Date(noon), timeZone);
}

/**
 * Ruling ANALYTICS-DAY-1: the key of the per-day analytics counters (`product_daily_views.date`, `qr_scan_daily.date`) for the
 * region day containing `d`: the UTC midnight (epoch ms) of the UTC date of that day's start instant. Cairo midnight is
 * 22:00Z (winter) / 21:00Z (summer) of the PREVIOUS UTC date, so the key of Cairo day D is the UTC midnight of D-1. This is
 * what the Postgres `date` columns held (the Date was cast to its UTC date), so copied history joins without a rewrite; it is
 * injective and monotone across DST. Writers and readers MUST both use it; never pass `regionDayStart(...)` to a DO op.
 */
export function regionDayKey(d: Date = new Date(), timeZone: string = REGION.timezone): number {
  return Math.floor(regionDayStart(d, timeZone).getTime() / DAY_MS) * DAY_MS;
}

/** `YYYY-MM` of the month containing `d` in `REGION.timezone`. */
export function regionYearMonth(d: Date, timeZone: string = REGION.timezone): string {
  return zonedIsoDay(d, timeZone).slice(0, 7);
}

/** The instant the month `YYYY-MM` starts in `REGION.timezone`. */
export function regionMonthStart(ym: string, timeZone: string = REGION.timezone): Date {
  return zonedDayStart(`${ym}-01`, timeZone) as Date;
}

// ─── FX ──────────────────────────────────────────────────────────────────────

/**
 * Convert minor units of `fromCurrency` into minor units of `toCurrency`
 * (default: the platform base, `REGION.currency`) at `rate` = how many MAJOR
 * units of `toCurrency` one MAJOR unit of `fromCurrency` is worth. Exponent-aware
 * (USD cents → EGP piastres, EGP piastres → BHD fils), rounded half up.
 */
export function convertMinor(
  amountMinor: number,
  rate: number,
  fromCurrency: string,
  toCurrency: string = REGION.currency
): number {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new RangeError(`rate must be a finite positive number, got: ${rate}`);
  }
  const shift = currencyExponent(toCurrency) - currencyExponent(fromCurrency);
  // FX is inherently approximate (the rate is a float / numeric(16,8)), so this
  // is the one place float math is accepted; the result is still rounded half
  // up (sign-symmetric) to an integer minor unit.
  const exact = Math.abs(amountMinor) * rate * 10 ** shift;
  const rounded = Math.floor(exact + 0.5);
  return amountMinor < 0 ? -rounded : rounded;
}
