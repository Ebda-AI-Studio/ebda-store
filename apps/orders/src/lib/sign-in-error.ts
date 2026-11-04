/**
 * Which login message an identity-service refusal maps to. A sign-in screen shows OUR sentence (Egyptian Arabic /
 * English by UI language), never the service's raw English ("Invalid email or password"). Pure so it is testable.
 */
export type SignInMessageKey =
  | 'invalidCredentials'
  | 'emailNotVerified'
  | 'tooManyAttempts'
  | 'invalidCode'
  | 'serverError';

export function signInMessageKey(status: number, code: string | undefined): SignInMessageKey {
  if (code === 'EMAIL_NOT_VERIFIED') return 'emailNotVerified';
  if (status === 429 || code === 'ACCOUNT_LOCKED' || code === 'TOO_MANY_ATTEMPTS') {
    return 'tooManyAttempts';
  }
  if (code === 'INVALID_CODE' || code === 'INVALID_CHALLENGE') return 'invalidCode';
  if (status === 401 || status === 403) return 'invalidCredentials';
  return 'serverError';
}

interface SignInTexts {
  failed: string;
  adminOnly: string;
  invalidCredentials: string;
  emailNotVerified: string;
  tooManyAttempts: string;
  invalidCode: string;
  serverError: string;
}

/** The page sentence for a code thrown by the auth provider; anything else (a raw message) becomes the generic failure. */
export function signInErrorText(code: string, texts: SignInTexts): string {
  if (code === 'ADMIN_ONLY') return texts.adminOnly;
  if (
    code === 'invalidCredentials' ||
    code === 'emailNotVerified' ||
    code === 'tooManyAttempts' ||
    code === 'invalidCode' ||
    code === 'serverError'
  ) {
    return texts[code];
  }
  return texts.failed;
}
