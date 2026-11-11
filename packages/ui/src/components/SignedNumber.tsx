import { signedParts, type SignedOptions } from '@ebda/shared';

export interface SignedNumberProps extends SignedOptions {
  value: number;
  className?: string;
}

/** A signed number as one LTR unit (SIGN-1): never "-0", never the minus on the wrong side in Arabic. */
export function SignedNumber({ value, className, ...opts }: SignedNumberProps) {
  const { sign, body } = signedParts(value, opts);
  return (
    <bdi dir="ltr" className={className}>
      {sign}
      {body}
    </bdi>
  );
}
