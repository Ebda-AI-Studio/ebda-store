import { signedParts, splitNumber, type SignedOptions } from '@ebda/shared';

export interface SignedNumberProps extends SignedOptions {
  value: number;
  className?: string;
}

/**
 * A signed number as one LTR unit (SIGN-1): never "-0", never the minus on the wrong side in Arabic.
 * Markup isolation (`<bdi dir="ltr">`), no hidden bidi characters in the text, so copy-paste into a
 * spreadsheet stays a number. A currency inside `format` stays outside the isolate.
 */
export function SignedNumber({ value, className, ...opts }: SignedNumberProps) {
  const { sign, body } = signedParts(value, opts);
  if (!sign) return <>{body}</>;
  const [before, num, after] = splitNumber(body);
  return (
    <>
      {before}
      <bdi dir="ltr" className={className}>
        {sign}
        {num}
      </bdi>
      {after}
    </>
  );
}
