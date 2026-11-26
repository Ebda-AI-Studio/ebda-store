/**
 * GTIN validation (GS1 mod-10). Google, Meta and TikTok reject or disapprove an item whose `gtin` fails the
 * checksum, so a merchant's free-text barcode (a shelf code, an internal id) must NEVER be sent as a gtin.
 * Accepted lengths: 8 (EAN-8), 12 (UPC-A), 13 (EAN-13/ISBN-13/JAN), 14 (ITF-14). Digits only.
 */
export function validGtin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw.trim().replace(/[\s-]/g, '');
  if (!/^\d+$/.test(d) || ![8, 12, 13, 14].includes(d.length)) return null;
  // all-zero is a placeholder, not a code
  if (/^0+$/.test(d)) return null;
  let sum = 0;
  for (let i = 0; i < d.length - 1; i++) {
    const digit = d.charCodeAt(d.length - 2 - i) - 48; // from the right, excluding the check digit
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  const check = (10 - (sum % 10)) % 10;
  return check === d.charCodeAt(d.length - 1) - 48 ? d : null;
}
