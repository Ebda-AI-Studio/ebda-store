import { describe, it, expect } from 'vitest';
import {
  passwordPolicyError,
  registrationRefusalText,
  validateRegistration,
} from '../../apps/web/src/app/auth/register/validate-registration';

const t = (en: string) => en;

describe('validateRegistration', () => {
  it('accepts a matching password that meets all five rules', () => {
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

  // Each rule alone missing -> that rule is named (the API enforces all five; the form used to check only length).
  it.each([
    ['Abc123!', 'Your password still needs: 8 characters or more.'],
    ['abcd123!', 'Your password still needs: An uppercase letter (A-Z).'],
    ['ABCD123!', 'Your password still needs: A lowercase letter (a-z).'],
    ['Abcdefg!', 'Your password still needs: A number (0-9).'],
    ['Abcd1234', 'Your password still needs: A symbol such as ! @ # $.'],
  ])('rejects %s and names the missing rule', (pw, message) => {
    expect(validateRegistration({ password: pw, confirmPassword: pw }, t)).toBe(message);
  });

  it('treats exactly 8 characters as valid when the policy is met (boundary)', () => {
    expect(
      validateRegistration({ password: 'Aa1!aaaa', confirmPassword: 'Aa1!aaaa' }, t)
    ).toBeNull();
  });

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

  it('lists every missing rule at once', () => {
    expect(validateRegistration({ password: '', confirmPassword: '' }, t)).toBe(
      'Your password still needs: 8 characters or more, An uppercase letter (A-Z), A lowercase letter (a-z), A number (0-9), A symbol such as ! @ # $.'
    );
  });

  it('uses the translator for the message it returns', () => {
    const ar = (_en: string, arText: string) => arText;
    expect(validateRegistration({ password: 'a', confirmPassword: 'b' }, ar)).toBe(
      'كلمة المرور وتأكيدها مش زي بعض'
    );
  });
});
