// @vitest-environment jsdom
/** Storefront login: the API answers EMAIL_NOT_VERIFIED (only after a correct password) -> message + resend button. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ loginWithPasskey: vi.fn(), login: vi.fn() }));
vi.mock('../../../components/ResendVerification', () => ({
  default: ({ email }: { email: string }) => <button>resend:{email}</button>,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock('@/lib/api', () => ({ api: { login: h.login } }));
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

beforeEach(() => h.login.mockReset());
afterEach(() => cleanup());

describe('storefront login: unverified email', () => {
  it('shows the verification message and the resend button on EMAIL_NOT_VERIFIED', async () => {
    h.login.mockResolvedValue({
      success: false,
      error: { code: 'EMAIL_NOT_VERIFIED', message: 'x' },
    });
    const { container } = render(<LoginClient />);
    fireEvent.change(container.querySelector('input[type="email"]') as HTMLInputElement, {
      target: { value: 'a@b.co' },
    });
    fireEvent.change(container.querySelector('input[type="password"]') as HTMLInputElement, {
      target: { value: 'Correct-Pass-1' },
    });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByText('resend:a@b.co')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('not verified');
  });

  it('shows NO resend button on a generic invalid-credentials failure', async () => {
    h.login.mockResolvedValue({
      success: false,
      error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
    });
    const { container } = render(<LoginClient />);
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Invalid'));
    expect(screen.queryByText(/resend:/)).toBeNull();
  });
});
