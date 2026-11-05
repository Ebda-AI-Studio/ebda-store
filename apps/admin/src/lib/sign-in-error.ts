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
