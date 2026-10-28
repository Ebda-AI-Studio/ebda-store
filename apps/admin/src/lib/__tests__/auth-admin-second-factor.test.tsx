// @vitest-environment jsdom
/**
 * Ruling ID-15: a platform admin who has a passkey but signed in with the password alone gets a session with no admin
 * power. login() must end that session and say so, never establish the Store session.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const h = vi.hoisted(() => ({
  login: vi.fn(),
  logout: vi.fn(async (..._a: unknown[]) => ({})),
  establish: vi.fn(),
}));

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/login',
}));
vi.mock('../accounts', () => ({
  AccountsError: class extends Error {},
  accountsLogin: (...a: unknown[]) => h.login(...a),
  accountsLoginMfa: vi.fn(),
  accountsLogout: (...a: unknown[]) => h.logout(...a),
  accountsToken: vi.fn(async () => {
    throw new Error('no session');
  }),
  establishApiSession: (...a: unknown[]) => h.establish(...a),
}));

import { AuthProvider, useAuth } from '../auth';

afterEach(cleanup);

function grabAuth() {
  let auth!: ReturnType<typeof useAuth>;
  function Probe() {
    auth = useAuth();
    return null;
  }
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );
  return () => auth;
}

describe('login for a platform admin with a passkey but no second-factor session', () => {
  it('shows the "use your passkey" message and never signs in to the Store (the server made no session)', async () => {
    h.login.mockResolvedValue({ secondFactorRequired: true });
    const get = grabAuth();
    await act(async () => {});
    await expect(get().login('boss@example.com', 'pw')).rejects.toThrow('adminNeedsSecondFactor');
    expect(h.logout).not.toHaveBeenCalled();
    expect(h.establish).not.toHaveBeenCalled();
  });
});
