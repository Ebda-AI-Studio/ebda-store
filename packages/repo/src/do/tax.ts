// DO port of the order tax computation: `resolveActiveTaxRate` / `frozenTaxInvoiceFields`
// (apps/api/src/lib/order-tax.ts) and `computeOrderTax` / `computeOrderAmounts` / `vatOnDiscounted`
// (packages/shared/src/order-tax.ts, region/index.ts). Pure and synchronous. Money is integer piastres.
//
// SQLite shapes: `tax_rates.rate` is percent x 100 (an integer in hundredths of a percent, i.e. basis points:
// 14.00% is 1400), `store_config.tax_enabled` / `tax_included_in_price` are 0/1. `default_tax_rate` and
// `default_tax_rate_bps` are NOT read: the charge never reads them (Ruling TAX-1a), same as Postgres.
import { MoneyError, type SyncSql } from './sync-sql';

const MAX_MONEY = 2_000_000_000;
const MAX_RATE_HUNDREDTHS = 99_999; // Decimal(5,2): 999.99%

function floorDiv(x: number, y: number): number {
  return (x - (x % y)) / y;
}

/** `round(amount * numerator / denominator)` half up in exact integers (same as shared `mulDivRound`). */
export function mulDivRound(amount: number, numerator: number, denominator: number): number {
  if (!Number.isInteger(amount) || !Number.isInteger(numerator) || !Number.isInteger(denominator))
    throw new MoneyError('AMOUNT_INVALID', 'mulDivRound requires integer arguments', 400);
  if (denominator <= 0)
    throw new MoneyError('AMOUNT_INVALID', 'mulDivRound requires a positive denominator', 400);
  const neg = amount !== 0 && numerator !== 0 && amount < 0 !== numerator < 0;
  const product = Math.abs(amount) * Math.abs(numerator);
  if (!Number.isSafeInteger(product * 2 + denominator))
    throw new MoneyError(
      'AMOUNT_OVERFLOW',
      'amount * numerator exceeds the safe integer range',
      400
    );
  const q = floorDiv(product * 2 + denominator, denominator * 2);
  return neg ? -q : q;
}

/** Port of `vatOnDiscounted`: base = max(0, subtotal - discount) + max(0, charges); inclusive extracts, exclusive adds. */
export function vatOnDiscounted(
  subtotalMinor: number,
  discountMinor: number,
  vatBps: number,
  includedInPrice = false,
  chargesMinor = 0
): number {
  const base = Math.max(0, subtotalMinor - discountMinor) + Math.max(0, chargesMinor);
  if (includedInPrice) return mulDivRound(base, vatBps, 10_000 + vatBps);
  return mulDivRound(base, vatBps, 10_000);
}

/** Port of `computeOrderTax`: `rate` is a FRACTION (0.14), converted to whole basis points exactly as the original does. */
export function computeOrderTax(
  subtotal: number,
  discount: number,
  rate: number,
  includedInPrice = false,
  chargesMinor = 0
): number {
  return vatOnDiscounted(
    subtotal,
    discount,
    Math.round(rate * 10_000),
    includedInPrice,
    chargesMinor
  );
}

export interface OrderAmountsInput {
  subtotal: number;
  discount: number;
  shipping: number;
  codFee?: number;
  ratePercent: number;
  includedInPrice?: boolean;
}
export interface OrderAmounts {
  /** Net value VAT is charged on (excl. VAT). */
  taxableAmount: number;
  tax: number;
  total: number;
}

const bad = (msg: string) => new MoneyError('INVALID_INPUT', msg, 400);
function money(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || Math.abs(v) > MAX_MONEY)
    throw bad(`${what} must be an integer number of piastres within +-2,000,000,000`);
  return v;
}

/**
 * Port of `computeOrderAmounts`: subtotal -> discounts -> shipping -> COD fee -> taxable amount -> VAT -> total.
 * Shipping and the COD fee are in the VAT base; inclusive pricing extracts the VAT (total = gross), exclusive adds it.
 */
export function computeOrderAmounts(i: OrderAmountsInput): OrderAmounts {
  const subtotal = money(i.subtotal, 'subtotal');
  const discount = money(i.discount, 'discount');
  const shipping = money(i.shipping, 'shipping');
  const codFee = i.codFee === undefined ? 0 : money(i.codFee, 'codFee');
  if (
    typeof i.ratePercent !== 'number' ||
    !Number.isFinite(i.ratePercent) ||
    i.ratePercent < 0 ||
    i.ratePercent > 999.99
  )
    throw bad('ratePercent must be a number between 0 and 999.99');
  const goods = Math.max(0, subtotal - discount);
  const charges = Math.max(0, shipping) + Math.max(0, codFee);
  const included = !!i.includedInPrice;
  const tax = computeOrderTax(subtotal, discount, i.ratePercent / 100, included, charges);
  const gross = goods + charges;
  return {
    taxableAmount: included ? Math.max(0, gross - tax) : gross,
    tax,
    total: included ? gross : gross + tax,
  };
}

export interface ActiveTaxRate {
  ratePercent: number;
  includedInPrice: boolean;
  seller: { taxRegistrationNumber: string; legalName: string } | null;
}

/**
 * Port of `resolveActiveTaxRate` (Rulings TAX-1, TAX-2): VAT is charged only when the merchant switched it on AND
 * its VAT profile is `verified` WITH a registration number and a legal name; the rate is the SUM of every ACTIVE
 * `tax_rates` row. Fail closed: no profile or any other status yields 0 and no seller identity.
 */
export function resolveActiveTaxRate(db: SyncSql, storeId: string): ActiveTaxRate {
  if (typeof storeId !== 'string' || !storeId) throw bad('storeId is required');
  const cfg = db.all(
    `SELECT tax_enabled, tax_included_in_price FROM store_config WHERE store_id = ?`,
    [storeId]
  )[0];
  const rates = db.all(`SELECT rate FROM tax_rates WHERE store_id = ? AND is_active = 1`, [
    storeId,
  ]);
  const profile = db.all(
    `SELECT status, tax_registration_number, legal_name FROM store_tax_profiles WHERE store_id = ?`,
    [storeId]
  )[0];

  let sumHundredths = 0;
  for (const r of rates) {
    const v = r.rate;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > MAX_RATE_HUNDREDTHS)
      throw new MoneyError(
        'TAX_CONFIG_CORRUPT',
        'a tax rate is not an integer in hundredths of a percent',
        500
      );
    sumHundredths += v;
  }
  const trn =
    typeof profile?.tax_registration_number === 'string' ? profile.tax_registration_number : '';
  const legal = typeof profile?.legal_name === 'string' ? profile.legal_name : '';
  const verified = profile?.status === 'verified' && !!trn && !!legal;
  const collecting = cfg?.tax_enabled === 1 && verified && sumHundredths > 0;
  return {
    ratePercent: collecting ? sumHundredths / 100 : 0,
    includedInPrice: cfg?.tax_included_in_price === 1,
    seller: collecting ? { taxRegistrationNumber: trn, legalName: legal } : null,
  };
}

/** Port of `frozenTaxInvoiceFields`: the seller identity + rate an order freezes, only when priced under a verified profile. */
export function frozenTaxInvoiceFields(active: ActiveTaxRate): {
  sellerTaxRegistrationNumber: string | null;
  sellerTaxLegalName: string | null;
  taxRateBps: number | null;
} {
  if (!active.seller || active.ratePercent <= 0)
    return { sellerTaxRegistrationNumber: null, sellerTaxLegalName: null, taxRateBps: null };
  return {
    sellerTaxRegistrationNumber: active.seller.taxRegistrationNumber,
    sellerTaxLegalName: active.seller.legalName,
    taxRateBps: Math.round(active.ratePercent * 100),
  };
}

export interface OrderTaxFields {
  tax: number;
  taxableAmount: number;
  total: number;
  /** orders.tax_included_in_price, 0/1 */
  taxIncludedInPrice: 0 | 1;
  taxRateBps: number | null;
  sellerTaxRegistrationNumber: string | null;
  sellerTaxLegalName: string | null;
  /** Fiscal document the order will get (fiscal-document.service: a seller TRN makes a tax invoice, otherwise a receipt). */
  documentKind: 'tax_invoice' | 'receipt';
}

/** Everything checkout stores for tax on one order: resolve the active rate, compute the amounts, freeze the identity. */
export function computeOrderTaxFields(
  db: SyncSql,
  storeId: string,
  amounts: { subtotal: number; discount: number; shipping: number; codFee?: number }
): OrderTaxFields {
  const active = resolveActiveTaxRate(db, storeId);
  const { tax, total, taxableAmount } = computeOrderAmounts({
    ...amounts,
    ratePercent: active.ratePercent,
    includedInPrice: active.includedInPrice,
  });
  const frozen = frozenTaxInvoiceFields(active);
  return {
    tax,
    taxableAmount,
    total,
    taxIncludedInPrice: active.includedInPrice ? 1 : 0,
    ...frozen,
    documentKind: frozen.sellerTaxRegistrationNumber ? 'tax_invoice' : 'receipt',
  };
}
