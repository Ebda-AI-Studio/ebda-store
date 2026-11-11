/**
 * Signed numbers inside Arabic text (R-02, quality-bar section 2; rule SIGN-1 in ebda-foundation design/DESIGN.md).
 * The logic lives in `@ebda/shared` (`signedText`, `formatSigned`); this file keeps the JSX twin and the old import path.
 */
import { MINUS, splitNumber, signedText, type Sign } from '@ebda/shared';

export { MINUS, signedText };
export type { Sign };

/** `<bdi dir="ltr">` around the sign and its number; the rest of the value keeps its order. */
export function SignedAmount({ sign, value }: { sign: Sign; value: string | number }) {
  const [before, num, after] = splitNumber(String(value));
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
