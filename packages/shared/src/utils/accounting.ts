/**
 * Chart-of-Accounts helpers shared between the admin UI and the API.
 *
 * The Kuwait small-retail COA (see `apps/api/src/services/accounting/coa-template.ts`)
 * numbers cash/bank accounts in the 1000–1099 band:
 *   1000 Cash KNET, 1010 Cash Card, 1020 Cash COD, 1030 Bank Main.
 * Other assets sit outside that band: 1100 Accounts Receivable, 1200 Inventory,
 * and any merchant-added 1100+/12xx accounts (Fixed Assets, Prepaid, etc.).
 *
 * The finance dashboard's "Cash by Account" widget already keys off this band
 * via `code LIKE '10%'`; this predicate is the single source of truth so the
 * expense "Paid From Account" dropdown and the server-side validation agree.
 */

/** Code-prefix that identifies the cash/bank band (1000–1099). */
export const CASH_BANK_CODE_PREFIX = '10';

/**
 * True when an account is a cash/bank account — i.e. an asset whose 4-digit
 * COA code falls in the 1000–1099 band. Money paid out of an expense MUST come
 * from one of these (debit expense, credit cash); paying "from" Inventory or a
 * Fixed Asset produces an incorrect double-entry.
 */
export function isCashOrBankAccount(account: { code: string; type?: string | null }): boolean {
  if (account.type != null && account.type !== 'asset') return false;
  return account.code.startsWith(CASH_BANK_CODE_PREFIX);
}

// ─── Multi-Currency Helpers ───────────────────────────────────────────────────

/**
 * ISO-4217 currency codes the platform accepts for non-KWD transactions.
 * Kept deliberately short — add codes as merchants request them.
 */
export const ALLOWED_CURRENCIES = [
  'KWD', // Kuwait Dinar — the base/reporting currency (1 KWD = 1000 fils)
  'USD', // US Dollar  (1 USD = 100 cents)
  'EUR', // Euro       (1 EUR = 100 cents)
  'GBP', // Pound Sterling (1 GBP = 100 pence)
  'SAR', // Saudi Riyal   (1 SAR = 100 halalas)
  'AED', // UAE Dirham    (1 AED = 100 fils)
  'QAR', // Qatari Riyal  (1 QAR = 100 dirhams)
  'BHD', // Bahraini Dinar (1 BHD = 1000 fils)
  'OMR', // Omani Rial    (1 OMR = 1000 baisa)
  'EGP', // Egyptian Pound (1 EGP = 100 piastres)
  'TRY', // Turkish Lira  (1 TRY = 100 kuruş)
  'INR', // Indian Rupee  (1 INR = 100 paise)
  'CNY', // Chinese Yuan  (1 CNY = 100 fen)
] as const;

export type AllowedCurrency = (typeof ALLOWED_CURRENCIES)[number];

/**
 * Convert a foreign-currency amount (in minor units) to KWD fils.
 *
 * Rounding rule: HALF-UP to the nearest integer fil.
 * Math.round() implements half-up for positive numbers (which all amounts are).
 *
 * @param originalAmount  Amount in the original currency's minor units
 *                        (e.g. cents for USD, halalas for SAR).
 * @param fxRate          Exchange rate: 1 unit of the original currency = fxRate KWD.
 *                        Accept both number and Prisma Decimal (serialised as string or object
 *                        with toString()). Throws if rate ≤ 0.
 * @returns               KWD amount in fils (integer, safe for DB storage).
 *
 * @example
 *   // 100 USD cents @ 0.307 KWD/USD → 31 fils (= 0.031 KWD)
 *   convertToKwd(100, 0.307) // → 31
 *
 *   // 1000 USD cents @ 0.307 → 307 fils (= 0.307 KWD)
 *   convertToKwd(1000, 0.307) // → 307
 *
 *   // KWD passthrough (fxRate=1) → amount unchanged
 *   convertToKwd(5000, 1) // → 5000
 */
export function convertToKwd(
  originalAmount: number,
  fxRate: number | { toString(): string }
): number {
  const rate = typeof fxRate === 'number' ? fxRate : Number(fxRate.toString());
  if (!isFinite(rate) || rate <= 0) {
    throw new RangeError(`fxRate must be a finite positive number, got: ${rate}`);
  }
  if (originalAmount < 0) {
    throw new RangeError(`originalAmount must be non-negative, got: ${originalAmount}`);
  }
  return Math.round(originalAmount * rate);
}

/**
 * True when the provided currency code requires an FX rate (i.e. is not KWD).
 */
export function requiresFxRate(currency: string): boolean {
  return currency.toUpperCase() !== 'KWD';
}
