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
