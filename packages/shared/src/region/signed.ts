/**
 * Signed numbers (design rule SIGN-1, ebda-foundation design/DESIGN.md).
 *
 * ONE formatter for every point, money delta, stock adjustment, refund, discount and percentage change.
 * - Zero never carries a sign: `-0`, `+0` and a value that rounds to zero print plain.
 * - Minus is U+2212 and the sign + number are wrapped in a bidi isolate (LRI...PDI) so RTL never moves the
 *   minus to the far side ("N-"). In JSX prefer <SignedNumber> (a `<bdi dir="ltr">`) or web's <SignedAmount>; this string form is for
 *   attributes, emails, CSV and text built outside JSX.
 * - Where meaning matters, prefer a word ("owed", "refunded") over the sign.
 * Hand-built `'-'`/`'+'` prefixes in TSX are blocked by tests/unit/signed-number-guard.test.ts.
 */
import { formatCount } from './numerals';

export const MINUS = '\u2212';
const LRI = '\u2066';
const PDI = '\u2069';

export type Sign = typeof MINUS | '+';

/** The first number in a formatted value: Western or Arabic-Indic digits, separators, an optional %. */
const NUMBER = /[0-9\u0660-\u0669](?:[0-9\u0660-\u0669.,\u066b\u066c]*[0-9\u0660-\u0669])?%?/;

/** Split a formatted value ("EGP 450", "21%", "450 ج.م") into [before, number, after]. */
export function splitNumber(value: string): [string, string, string] {
  const m = NUMBER.exec(value);
  if (!m) return ['', value, ''];
  return [value.slice(0, m.index), m[0], value.slice(m.index + m[0].length)];
}

/** Isolate the sign with its number only ("EGP LRI-450PDI"); a currency keeps its own place. */
export function signedText(sign: Sign, value: string | number): string {
  const [before, num, after] = splitNumber(String(value));
  return `${before}${LRI}${sign}${num}${PDI}${after}`;
}

export interface SignedOptions {
  language?: string | null;
  /** Show `+` for positive values (earned/credit). Default false. */
  plus?: boolean;
  /** Fraction digits kept before the zero test (percentages: 1). Default 0. */
  fractionDigits?: number;
  /** Format the ABSOLUTE value (e.g. money). Default: grouped Western digits. */
  format?: (abs: number) => string;
}

/** Sign and body for a value, with the zero rule applied. `sign` is '' for zero. */
export function signedParts(
  value: number,
  opts: SignedOptions = {}
): { sign: '' | '+' | typeof MINUS; body: string } {
  const d = opts.fractionDigits ?? 0;
  const factor = 10 ** d;
  const rounded = Number.isFinite(value) ? Math.round(Math.abs(value) * factor) / factor : 0;
  const body = opts.format
    ? opts.format(rounded)
    : formatCount(rounded, opts.language ?? 'en', 'latn', {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      });
  if (rounded === 0) return { sign: '', body };
  if (value < 0) return { sign: MINUS, body };
  return { sign: opts.plus ? '+' : '', body };
}

/** `\u2212450` / `+450` / `0` as a string; sign + number are one LTR isolate, a currency in `format` keeps its place. */
export function formatSigned(value: number, opts: SignedOptions = {}): string {
  const { sign, body } = signedParts(value, opts);
  return sign ? signedText(sign, body) : body;
}
