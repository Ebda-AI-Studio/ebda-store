/** Ebda's own billing receipts always print this shape (Ahmad, 2026-10-21). */
export const EBDA_BILLING_BARCODE_SHAPE = 'palm';

/**
 * The scannable payment number of an Ebda subscription charge: `EBD-` + the
 * first 10 hex digits of the charge id, uppercased. Deterministic, Code 128 B
 * safe, short enough to stay scannable inside the palm. (There is no separate
 * invoice-number sequence for subscription charges today.)
 */
export function billingPaymentNumber(chargeId: string): string {
  const hex = chargeId.replace(/[^0-9a-fA-F]/g, '').slice(0, 10).toUpperCase();
  if (hex.length < 6) throw new Error('billingPaymentNumber: not a charge id');
  return `EBD-${hex}`;
}
