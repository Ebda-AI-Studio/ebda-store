import { describe, it, expect } from 'vitest';
import {
  passwordPolicyError,
  registrationRefusalText,
  validateRegistration,
} from '../../apps/web/src/app/auth/register/validate-registration';

const t = (en: string) => en;

describe('validateRegistration', () => {
  it('accepts a matching password that meets the API policy', () => {
    expect(
      validateRegistration({ password: 'Abcd123!', confirmPassword: 'Abcd123!' }, t)
    ).toBeNull();
  });

  it('rejects a mismatch before checking length', () => {
    // Mismatch is reported first so the shopper fixes the obvious thing.
    expect(validateRegistration({ password: 'abc', confirmPassword: 'xyz' }, t)).toBe(
      'Passwords do not match'
    );
  });

  it('rejects a password shorter than 8 characters', () => {
    expect(validateRegistration({ password: 'abc1234', confirmPassword: 'abc1234' }, t)).toBe(
      'Password must be at least 8 characters'
    );
  });

  it('treats exactly 8 characters as valid when the policy is met (boundary)', () => {
    expect(
      validateRegistration({ password: 'Aa1!aaaa', confirmPassword: 'Aa1!aaaa' }, t)
    ).toBeNull();
  });

  it.each([['abcd1234'], ['ABCD1234!'], ['abcd!@#$'], ['Abcdefg!'], ['12345678']])(
    'refuses %s before the request: the API (upper, lower, digit, symbol) would answer 400 in English (2026-11-18)',
    pw => {
      const ar = (_en: string, arText: string) => arText;
      expect(validateRegistration({ password: pw, confirmPassword: pw }, ar)).toBe(
        'كلمة المرور لازم يكون فيها حرف إنجليزي كبير وحرف صغير ورقم ورمز زي ! أو @، و8 حروف على الأقل.'
      );
    }
  );

  it('the same policy is what the storefront reset page uses', () => {
    expect(passwordPolicyError('abcd1234', t)).not.toBeNull();
    expect(passwordPolicyError('Abcd123!', t)).toBeNull();
  });

  it("the register API's 400 is shown in the shopper's language, other refusals are left alone", () => {
    const ar = (_en: string, arText: string) => arText;
    expect(registrationRefusalText({ code: 'VALIDATION_ERROR' }, ar)).toContain('راجع البيانات');
    expect(registrationRefusalText({ code: 'RATE_LIMITED' }, ar)).toBeNull();
    expect(registrationRefusalText(null, ar)).toBeNull();
  });

  it('rejects two empty passwords — they match but are too short', () => {
    expect(validateRegistration({ password: '', confirmPassword: '' }, t)).toBe(
      'Password must be at least 8 characters'
    );
  });

  it('uses the translator for the message it returns', () => {
    const ar = (_en: string, arText: string) => arText;
    expect(validateRegistration({ password: 'a', confirmPassword: 'b' }, ar)).toBe(
      'كلمة المرور وتأكيدها مش زي بعض'
    );
  });
});
