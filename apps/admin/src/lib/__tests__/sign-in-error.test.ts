import { describe, expect, it } from 'vitest';
import { signInMessageKey } from '../sign-in-error';

describe('signInMessageKey (audit A-1: no raw English on the sign-in page)', () => {
  it.each([
    [401, 'INVALID_CREDENTIALS', 'invalidCredentials'],
    [403, 'EMAIL_NOT_VERIFIED', 'emailNotVerified'],
    [429, 'ACCOUNT_LOCKED', 'tooManyAttempts'],
    [429, undefined, 'tooManyAttempts'],
    [429, 'TOO_MANY_ATTEMPTS', 'tooManyAttempts'],
    [401, 'INVALID_CODE', 'invalidCode'],
    [401, 'INVALID_CHALLENGE', 'invalidCode'],
    [403, 'ORIGIN_NOT_ALLOWED', 'invalidCredentials'],
    [500, 'INTERNAL', 'serverError'],
    [503, 'DIRECTORY_UNAVAILABLE', 'serverError'],
  ] as const)('%s %s -> %s', (status, code, key) => {
    expect(signInMessageKey(status, code)).toBe(key);
  });
});
