/**
 * EAN-13 / UPC-A (BARCODE-1). Product barcodes the shop prints on labels.
 * Auto-generated codes use the GS1 in-store ("restricted circulation") prefixes 20-29, so they can
 * never collide with a real retail code. UPC-A is an EAN-13 with a leading 0.
 */

/** Check digit of the first 12 digits of an EAN-13 (or the first 11 of a UPC-A, left-padded by the caller). */
export function ean13CheckDigit(d12: string): number {
  if (!/^\d{12}$/.test(d12)) throw new Error('ean13: need 12 digits');
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(value: string): boolean {
  return /^\d{13}$/.test(value) && ean13CheckDigit(value.slice(0, 12)) === Number(value[12]);
}

export function isValidUpcA(value: string): boolean {
  return /^\d{12}$/.test(value) && isValidEan13(`0${value}`);
}

/** GS1 in-store range: 20-29. `serial` fills the 10 digits after the prefix. */
export function makeInStoreEan13(prefix: number, serial: number): string {
  if (!Number.isInteger(prefix) || prefix < 20 || prefix > 29)
    throw new Error('ean13: prefix 20-29');
  if (!Number.isInteger(serial) || serial < 0 || serial > 9_999_999_999)
    throw new Error('ean13: serial');
  const d12 = `${prefix}${String(serial).padStart(10, '0')}`;
  return `${d12}${ean13CheckDigit(d12)}`;
}

export const isInStoreEan13 = (v: string) => isValidEan13(v) && /^2\d/.test(v);

// Digit encodings, 7 modules each (1 = bar).
const L = [
  '0001101',
  '0011001',
  '0010011',
  '0111101',
  '0100011',
  '0110001',
  '0101111',
  '0111011',
  '0110111',
  '0001011',
];
const G = [
  '0100111',
  '0110011',
  '0011011',
  '0100001',
  '0011101',
  '0111001',
  '0000101',
  '0010001',
  '0001001',
  '0010111',
];
const R = [
  '1110010',
  '1100110',
  '1101100',
  '1000010',
  '1011100',
  '1001110',
  '1010000',
  '1000100',
  '1001000',
  '1110100',
];
// Which of the six left digits use G, by the first digit.
const PARITY = [
  'LLLLLL',
  'LLGLGG',
  'LLGGLG',
  'LLGGGL',
  'LGLLGG',
  'LGGLLG',
  'LGGGLL',
  'LGLGLG',
  'LGLGGL',
  'LGGLGL',
];

export const EAN_L = L;
export const EAN_G = G;
export const EAN_R = R;
export const EAN_PARITY = PARITY;

/** 95 modules: guard, 6 digits, centre guard, 6 digits, guard. Throws on a bad length/check digit. */
export function ean13Modules(value: string): boolean[] {
  if (!isValidEan13(value)) throw new Error('ean13: invalid value');
  const first = Number(value[0]);
  let bits = '101';
  for (let i = 0; i < 6; i++) {
    const d = Number(value[i + 1]);
    bits += PARITY[first][i] === 'L' ? L[d] : G[d];
  }
  bits += '01010';
  for (let i = 7; i < 13; i++) bits += R[Number(value[i])];
  bits += '101';
  return [...bits].map(c => c === '1');
}

export type BarcodeKind = 'ean13' | 'upca' | 'code128';
export type ParsedBarcode =
  | { ok: true; kind: BarcodeKind; value: string }
  | { ok: false; reason: 'empty' | 'check-digit' | 'charset' | 'length' };

const ARABIC_INDIC = /[٠-٩]/g;
const PERSIAN = /[۰-۹]/g;
export const CODE128_INPUT_MAX = 48;

/**
 * What a merchant typed or a scanner sent. 13 digits = EAN-13 and 12 digits = UPC-A, both with a
 * REQUIRED valid check digit (a typo must not become a code nobody can scan); anything else is
 * Code 128 text (printable ASCII, 1-48 characters). Arabic-Indic and Persian digits fold to ASCII
 * and surrounding spaces go, so a code pasted from an Arabic keyboard works.
 */
export function parseBarcodeInput(raw: string): ParsedBarcode {
  const value = raw
    .replace(ARABIC_INDIC, d => String(d.charCodeAt(0) - 0x0660))
    .replace(PERSIAN, d => String(d.charCodeAt(0) - 0x06f0))
    .trim();
  if (!value) return { ok: false, reason: 'empty' };
  if (/^\d{13}$/.test(value)) {
    return isValidEan13(value)
      ? { ok: true, kind: 'ean13', value }
      : { ok: false, reason: 'check-digit' };
  }
  if (/^\d{12}$/.test(value)) {
    return isValidUpcA(value)
      ? { ok: true, kind: 'upca', value }
      : { ok: false, reason: 'check-digit' };
  }
  if (!/^[\x20-\x7e]+$/.test(value)) return { ok: false, reason: 'charset' };
  if (value.length > CODE128_INPUT_MAX) return { ok: false, reason: 'length' };
  return { ok: true, kind: 'code128', value };
}

/** The modules a printed label carries for a parsed code (UPC-A prints as its EAN-13 with a leading 0). */
export function barcodeModulesFor(
  parsed: Extract<ParsedBarcode, { ok: true }>,
  code128: (v: string) => boolean[]
): boolean[] {
  if (parsed.kind === 'ean13') return ean13Modules(parsed.value);
  if (parsed.kind === 'upca') return ean13Modules(`0${parsed.value}`);
  return code128(parsed.value);
}
