// @vitest-environment jsdom
/**
 * Review M3 (storefront): no passkey /begin request on page load. The conditional-UI ceremony starts
 * once, on the first focus of the email field; the button starts a normal prompt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ loginWithPasskey: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock('@/lib/api', () => ({ api: { login: vi.fn() } }));
vi.mock('../../../components', () => ({
  MinimalChrome: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../../contexts/CartContext', () => ({
  useCart: () => ({ syncCartToBackend: vi.fn() }),
}));
vi.mock('../../../contexts/StoreContext', () => ({
  useStoreUrl: () => (p: string) => p,
  useStore: () => ({ store: { id: 'store-1' } }),
}));
vi.mock('../../../contexts/LanguageContext', () => ({
  useLanguage: () => ({ t: (en: string) => en }),
}));
vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({ loginWithPasskey: h.loginWithPasskey }),
}));
vi.mock('../../../lib/passkeys', () => ({
  passkeysSupported: () => true,
  passkeyAutofillSupported: async () => true,
  isPasskeyCancel: () => true,
}));

import LoginClient from './LoginClient';

beforeEach(() => {
  h.loginWithPasskey.mockReset();
  h.loginWithPasskey.mockReturnValue(new Promise(() => undefined));
});
afterEach(() => cleanup());

describe('storefront login: passkey options are fetched on demand', () => {
  it('does NOT start a ceremony just by loading the page', async () => {
    render(<LoginClient />);
    await new Promise(r => setTimeout(r, 20));
    expect(h.loginWithPasskey).not.toHaveBeenCalled();
  });

  it('starts the conditional ceremony once, on the first focus of the email field', async () => {
    const { container } = render(<LoginClient />);
    const email = container.querySelector('input[type="email"]') as HTMLInputElement;
    fireEvent.focus(email);
    await waitFor(() => expect(h.loginWithPasskey).toHaveBeenCalledWith(true));
    fireEvent.blur(email);
    fireEvent.focus(email);
    await new Promise(r => setTimeout(r, 20));
    expect(h.loginWithPasskey).toHaveBeenCalledTimes(1);
  });

  it('the button starts a normal prompt', async () => {
    render(<LoginClient />);
    fireEvent.click(await screen.findByText('Sign in with Face ID or a passkey'));
    await waitFor(() => expect(h.loginWithPasskey).toHaveBeenCalledWith(false));
  });
});
