// @vitest-environment jsdom
/**
 * Review M3: the login page must not call the passkey /begin endpoint on every load (a CGNAT egress full
 * of shoppers/merchants would exhaust the limiter). The conditional-UI ceremony starts ON DEMAND: when
 * the person focuses the email field (once), and the button starts a normal prompt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ loginWithPasskey: vi.fn() }));

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({
    login: vi.fn(),
    completeMfaLogin: vi.fn(),
    loginWithPasskey: h.loginWithPasskey,
    isLoading: false,
    isAuthenticated: false,
  }),
  postLoginDestination: () => '/',
}));
vi.mock('../../lib/passkeys', () => ({
  passkeysSupported: () => true,
  passkeyAutofillSupported: async () => true,
  isPasskeyCancel: () => true,
}));

import LoginPage from './page';

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  h.loginWithPasskey.mockReset();
  h.loginWithPasskey.mockReturnValue(new Promise(() => undefined)); // a pending ceremony, like the real one
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('admin login: passkey options are fetched on demand', () => {
  it('does NOT start a ceremony (no /begin request) just by loading the page', async () => {
    render(<LoginPage />);
    await new Promise(r => setTimeout(r, 20));
    expect(h.loginWithPasskey).not.toHaveBeenCalled();
  });

  it('starts the conditional ceremony once, when the email field is focused', async () => {
    const { container } = render(<LoginPage />);
    const email = container.querySelector('input[type="email"]') as HTMLInputElement;
    fireEvent.focus(email);
    await waitFor(() => expect(h.loginWithPasskey).toHaveBeenCalledWith('conditional'));
    fireEvent.blur(email);
    fireEvent.focus(email);
    await new Promise(r => setTimeout(r, 20));
    expect(h.loginWithPasskey).toHaveBeenCalledTimes(1);
  });

  it('the button starts a normal (modal) ceremony', async () => {
    render(<LoginPage />);
    fireEvent.click(await screen.findByText('passkeySignIn'));
    await waitFor(() => expect(h.loginWithPasskey).toHaveBeenCalledWith('modal'));
  });
});
