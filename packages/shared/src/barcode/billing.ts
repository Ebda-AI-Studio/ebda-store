/** Ebda's own billing receipts always print this shape (Ahmad, 2026-10-21). */
export const EBDA_BILLING_BARCODE_SHAPE = 'palm';

// BigInt() calls, not literals: the shared package targets < ES2020.
const FNV_OFFSET = BigInt('0xcbf29ce484222325');
const FNV_PRIME = BigInt('0x100000001b3');
const MASK64 = BigInt('0xffffffffffffffff');
const TEN_16 = BigInt('10000000000000000');

/**
 * The scannable payment number of an Ebda subscription charge: `EBD-` + 16
 * digits (Code 128 C, so it stays wide enough to scan), the 64-bit FNV-1a hash
 * of the WHOLE charge id mod 10^16. Works for any id shape (uuid, cuid) and
 * keeps all of its entropy, unlike a hex prefix. There is no billing invoice
 * sequence for subscription charges today (Ruling BARCODE-3); a display
 * number, not a secret or a key.
 */
export function billingPaymentNumber(chargeId: string): string {
  if (!chargeId) throw new Error('billingPaymentNumber: empty charge id');
  let h = FNV_OFFSET;
  for (let i = 0; i < chargeId.length; i++) {
    h ^= BigInt(chargeId.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return `EBD-${(h % TEN_16).toString().padStart(16, '0')}`;
}
