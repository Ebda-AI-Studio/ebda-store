import { describe, it, expect } from 'vitest';
import { validateRegistration } from '../../apps/web/src/app/auth/register/validate-registration';

const t = (en: string) => en;

describe('validateRegistration', () => {
  it('accepts a matching password of at least 8 characters', () => {
    expect(
      validateRegistration({ password: 'abcd1234', confirmPassword: 'abcd1234' }, t)
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

  it('treats exactly 8 characters as valid (boundary)', () => {
    expect(
      validateRegistration({ password: '12345678', confirmPassword: '12345678' }, t)
    ).toBeNull();
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
