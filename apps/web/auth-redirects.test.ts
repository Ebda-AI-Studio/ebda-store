import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { authRedirects } = createRequire(import.meta.url)('./auth-redirects.js') as {
  authRedirects: () => Array<{ source: string; destination: string; permanent: boolean }>;
};

describe('auth alias redirects', () => {
  const rules = authRedirects();
  it('sends /account/register (with and without a locale) to the real register page', () => {
    expect(rules).toContainEqual({
      source: '/account/register',
      destination: '/auth/register',
      permanent: false,
    });
    expect(rules).toContainEqual({
      source: '/:locale(ar|en)/account/register',
      destination: '/:locale/auth/register',
      permanent: false,
    });
  });
  it('never shadows a real route: every destination is under /auth and no source is under /auth', () => {
    for (const r of rules) {
      expect(r.destination).toMatch(/^\/(:locale\/)?auth\/(register|login)$/);
      expect(r.source).not.toMatch(/\/auth\//);
    }
  });
});
