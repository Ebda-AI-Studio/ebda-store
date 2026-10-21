/**
 * The value actually encoded in the barcode. The full order number
 * (`ORD-T5JK9Q-AB3XY`, 16 chars) needs 253 Code 128 B modules, which cannot be
 * 2 css px wide on a phone-width receipt. The standard number is two base36
 * fields, so it packs reversibly into 18 DIGITS (Code 128 C, 2 digits per
 * symbol): 154 modules. No database mapping; `orderNumberFromScanCode` inverts it.
 *
 *   ORD-<6 base36>-<5 base36>  ->  10-digit decimal of field 1 + 8-digit of field 2
 *   EBD-<16 digits>            ->  the 16 digits (Ebda billing payment number)
 *   anything else (old 24-char numbers, '1043', manual numbers) -> unchanged
 *
 * Caveat: a non-standard order number that is itself exactly 18 (or 16) digits
 * would be read back as ORD-/EBD-; none exist (numbers are generated).
 */
const ORD = /^ORD-([0-9A-Z]{6})-([0-9A-Z]{5})$/;
const EBD = /^EBD-(\d{16})$/;

export function scanCodeFor(orderNumber: string): string {
  const m = ORD.exec(orderNumber);
  if (m) {
    return (
      parseInt(m[1]!, 36).toString().padStart(10, '0') +
      parseInt(m[2]!, 36).toString().padStart(8, '0')
    );
  }
  const e = EBD.exec(orderNumber);
  if (e) return e[1]!;
  return orderNumber;
}

export function orderNumberFromScanCode(code: string): string {
  if (/^\d{18}$/.test(code)) {
    const a = Number(code.slice(0, 10));
    const b = Number(code.slice(10));
    // Only a valid pair maps back (6 and 5 base36 digits).
    if (a < 36 ** 6 && b < 36 ** 5) {
      return `ORD-${a.toString(36).toUpperCase().padStart(6, '0')}-${b.toString(36).toUpperCase().padStart(5, '0')}`;
    }
    return code;
  }
  if (/^\d{16}$/.test(code)) return `EBD-${code}`;
  return code;
}
