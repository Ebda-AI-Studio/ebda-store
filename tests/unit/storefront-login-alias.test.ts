/** G73: guessed login URLs redirect to the one real `/auth/login`, query (returnTo) intact. */
import { describe, it, expect } from 'vitest';
import { loginAliasRedirect } from '@web/lib/login-alias';

describe('loginAliasRedirect', () => {
  it.each([
    '/login',
    '/account/login',
    '/ar/login',
    '/ar/account/login',
    '/en/login/',
    '/AR/Login',
  ])('%s -> /auth/login', p => {
    expect(loginAliasRedirect(p, '')?.location).toBe('/auth/login');
  });
  it('keeps returnTo and reports the language prefix', () => {
    expect(loginAliasRedirect('/ar/login', '?returnTo=%2Fcart')).toEqual({
      location: '/auth/login?returnTo=%2Fcart',
      locale: 'ar',
    });
    expect(loginAliasRedirect('/login', '')?.locale).toBeNull();
  });
  it.each([
    '/auth/login',
    '/products/login',
    '/ar/products/login',
    '/login/extra',
    '/account',
    '/loginx',
  ])('leaves %s alone', p => {
    expect(loginAliasRedirect(p, '')).toBeNull();
  });
});
