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

describe('login by a customer account (not staff)', () => {
  it('is refused with the accessDenied message, ends both sessions and arms NO refresh timer', async () => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
    );
    h.login.mockResolvedValue({ access_token: 'tok', expires_at: Date.now() + 900_000 });
    h.establish.mockResolvedValue({ id: 'c1', role: 'customer' });
    h.logout.mockClear();
    const get = grabAuth();
    await act(async () => {});
    vi.useFakeTimers();
    try {
      await expect(get().login('shopper@example.com', 'pw')).rejects.toThrow('accessDenied');
      expect(h.logout).toHaveBeenCalledWith('tok');
      expect(vi.getTimerCount()).toBe(0); // rememberGrant would have armed the proactive refresh
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
