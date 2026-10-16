/**
 * Signed numbers inside Arabic text (R-02, quality-bar § 2).
 *
 * In a right-to-left paragraph a leading sign is a neutral character: the bidi
 * algorithm hands it the paragraph's direction and paints it AFTER the digits,
 * so "-21%" read "21%-" and "+2" read "2+" on every Arabic card. The fix is to
 * isolate the sign with its number left-to-right (`<bdi dir="ltr">`) and to use
 * the real minus sign U+2212, not a hyphen.
 *
 * Only the number and its sign are isolated: an Arabic amount keeps its own
 * order ("ج.م −450" on screen, the currency where every unsigned price puts it).
 *
 * Two shapes, one rule:
 *  - `<SignedAmount>` for JSX: renders `<bdi dir="ltr">−450</bdi>`;
 *  - `signedText()` for a value that must stay a string (a badge text, a label):
 *    the same isolation through U+2066 LEFT-TO-RIGHT ISOLATE … U+2069 POP
 *    DIRECTIONAL ISOLATE, which is what `<bdi dir="ltr">` means in HTML.
 */

/** U+2212 MINUS SIGN. */
export const MINUS = '−';
const LRI = '⁦';
const PDI = '⁩';

export type Sign = typeof MINUS | '+';

/** The first number in a formatted value: Western or Arabic-Indic digits, separators, an optional %. */
const NUMBER = /[0-9٠-٩](?:[0-9٠-٩.,٫٬]*[0-9٠-٩])?%?/;

function split(value: string): [string, string, string] {
  const m = NUMBER.exec(value);
  if (!m) return ['', value, ''];
  return [value.slice(0, m.index), m[0], value.slice(m.index + m[0].length)];
}

/** String twin of `<SignedAmount>`: "EGP ⁦−450⁩", "⁦−21%⁩", "⁦−450⁩ ج.م". */
export function signedText(sign: Sign, value: string | number): string {
  const [before, num, after] = split(String(value));
  return `${before}${LRI}${sign}${num}${PDI}${after}`;
}

/** `<bdi dir="ltr">` around the sign and its number; the rest of the value keeps its order. */
export function SignedAmount({ sign, value }: { sign: Sign; value: string | number }) {
  const [before, num, after] = split(String(value));
  return (
    <>
      {before}
      <bdi dir="ltr">
        {sign}
        {num}
      </bdi>
      {after}
    </>
  );
}
