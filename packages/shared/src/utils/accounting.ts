/**
 * Chart-of-Accounts helpers shared between the admin UI and the API.
 *
 * The small-retail COA (see `apps/api/src/services/accounting/coa-template.ts`)
 * numbers cash/bank accounts in the 1000–1099 band:
 *   1000 Cash Online, 1010 Cash Card, 1020 Cash COD, 1030 Bank Main.
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

import { REGION, convertMinor } from '../region';

// ─── Multi-Currency Helpers ───────────────────────────────────────────────────

/**
 * ISO-4217 currency codes the platform accepts. The base/reporting currency is
 * `REGION.currency` (EGP); every other code is a foreign-currency transaction
 * that needs an FX rate. Minor-unit scale comes from `currencyExponent`.
 * Kept deliberately short — add codes as merchants request them.
 */
export const ALLOWED_CURRENCIES = [
  'EGP', // Egyptian Pound (1 EGP = 100 piastres) — the base/reporting currency
  'USD', // US Dollar  (1 USD = 100 cents)
  'EUR', // Euro       (1 EUR = 100 cents)
  'GBP', // Pound Sterling (1 GBP = 100 pence)
  'SAR', // Saudi Riyal   (1 SAR = 100 halalas)
  'AED', // UAE Dirham    (1 AED = 100 fils)
  'QAR', // Qatari Riyal  (1 QAR = 100 dirhams)
  'BHD', // Bahraini Dinar (1 BHD = 1000 fils)
  'OMR', // Omani Rial    (1 OMR = 1000 baisa)
  'TRY', // Turkish Lira  (1 TRY = 100 kuruş)
  'INR', // Indian Rupee  (1 INR = 100 paise)
  'CNY', // Chinese Yuan  (1 CNY = 100 fen)
] as const;

export type AllowedCurrency = (typeof ALLOWED_CURRENCIES)[number];

/**
 * Convert a foreign-currency amount (in that currency's minor units) to the
 * BASE currency's minor units (`REGION.currency`, EGP piastres).
 *
 * Rounding rule: HALF-UP to the nearest integer minor unit. Exponent-aware
 * (USD cents → EGP piastres is ×rate; EGP → BHD would shift by one decimal).
 *
 * @param originalAmount  Amount in the original currency's minor units
 *                        (e.g. cents for USD, halalas for SAR).
 * @param fxRate          1 MAJOR unit of the original currency = fxRate MAJOR units of the
 *                        base currency. Accepts number or Prisma Decimal (anything with
 *                        toString()). Throws if rate ≤ 0.
 * @param originalCurrency Currency of `originalAmount` (default: the base — passthrough scale).
 * @returns               Base-currency amount in minor units (integer, safe for DB storage).
 *
 * @example
 *   // 100 USD cents @ 50 EGP/USD → 5000 piastres (= 50.00 EGP)
 *   convertToBase(100, 50, 'USD') // → 5000
 *
 *   // base-currency passthrough (fxRate=1) → amount unchanged
 *   convertToBase(5000, 1) // → 5000
 */
export function convertToBase(
  originalAmount: number,
  fxRate: number | { toString(): string },
  originalCurrency: string = REGION.currency
): number {
  const rate = typeof fxRate === 'number' ? fxRate : Number(fxRate.toString());
  if (!isFinite(rate) || rate <= 0) {
    throw new RangeError(`fxRate must be a finite positive number, got: ${rate}`);
  }
  if (originalAmount < 0) {
    throw new RangeError(`originalAmount must be non-negative, got: ${originalAmount}`);
  }
  return convertMinor(originalAmount, rate, originalCurrency, REGION.currency);
}

/**
 * True when the provided currency code requires an FX rate (i.e. is not the
 * base currency, `REGION.currency`).
 */
export function requiresFxRate(currency: string): boolean {
  return currency.toUpperCase() !== REGION.currency;
}
