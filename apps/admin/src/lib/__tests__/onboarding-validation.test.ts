import { describe, expect, it } from 'vitest';
import {
  egpToPiastres,
  isStrongPassword,
  suggestSlug,
  validateSignup,
} from '../onboarding-validation';
import { isPublicPath } from '../auth';

describe('onboarding validation', () => {
  it('egpToPiastres converts EGP to integer piastres and rejects junk', () => {
    expect(egpToPiastres('250')).toBe(25000);
    expect(egpToPiastres('250.5')).toBe(25050);
    expect(egpToPiastres('0.99')).toBe(99);
    expect(egpToPiastres('٢٥٠')).toBe(25000); // Eastern Arabic digits
    expect(egpToPiastres('250,50')).toBe(25050);
    for (const bad of ['', '0', '0.00', '-5', 'abc', '1.234', '1e3', '12 EGP']) {
      expect(egpToPiastres(bad), bad).toBeNull();
    }
  });

  it('isStrongPassword mirrors the API policy', () => {
    expect(isStrongPassword('Str0ng!Passw0rd')).toBe(true);
    for (const weak of [
      'Sh0rt!A',
      'alllowercase1!',
      'ALLUPPERCASE1!',
      'NoDigits!!!',
      'NoSymbol123A',
    ]) {
      expect(isStrongPassword(weak), weak).toBe(false);
    }
  });

  it('validateSignup keeps phone optional but strict when given', () => {
    const ok = { name: 'Mona', email: 'm@x.com', phone: '', password: 'Str0ng!Passw0rd' };
    expect(validateSignup(ok)).toEqual({});
    expect(validateSignup({ ...ok, phone: '010 1234 5678' })).toEqual({});
    expect(validateSignup({ ...ok, phone: '+14155550123' }).phone).toBe('phoneInvalid');
    expect(validateSignup({ ...ok, name: '  ' }).name).toBe('nameRequired');
  });

  it('suggestSlug yields a latin address, empty for Arabic-only names', () => {
    expect(suggestSlug('My  Shop!')).toBe('my-shop');
    expect(suggestSlug('متجر منى')).toBe('');
    expect(suggestSlug('a'.repeat(60))).toHaveLength(40);
  });

  it('the funnel pages are reachable without a session, the dashboard is not', () => {
    for (const p of ['/login', '/signup', '/verify-email', '/signup/']) {
      expect(isPublicPath(p), p).toBe(true);
    }
    for (const p of ['/', '/onboarding', '/stores/x', '/signup-evil', null]) {
      expect(isPublicPath(p), String(p)).toBe(false);
    }
  });
});
