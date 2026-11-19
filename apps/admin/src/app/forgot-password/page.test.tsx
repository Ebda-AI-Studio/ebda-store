// @vitest-environment jsdom
/**
 * Forgot-password page: one neutral "check your email" screen whatever the API
 * knows about the address (no account enumeration from the UI side either).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

const { accountsFetch } = vi.hoisted(() => ({ accountsFetch: vi.fn() }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ isAuthenticated: false, user: null, logout: () => undefined }),
}));
vi.mock('../../lib/accounts', () => ({
  accountsFetch,
  AccountsError: class AccountsError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string
    ) {
      super(message);
    }
  },
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('next/image', () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));
vi.mock('@/i18n/useT', () => {
  const useT = (ns?: string) => (key: string) => `${ns ? `${ns}.` : ''}${key}`;
  return { useT };
});

import ForgotPasswordPage from './page';

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={{}}>
      <ForgotPasswordPage />
    </NextIntlClientProvider>
  );
}

function submit(email: string) {
  fireEvent.change(screen.getByLabelText('auth.forgot.email'), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: 'auth.forgot.submit' }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('forgot-password page', () => {
  it('posts the trimmed address to the identity service and shows the neutral sent screen', async () => {
    accountsFetch.mockResolvedValue({ status: 'sent_if_registered' });
    renderPage();
    submit('  owner@shop.test ');
    expect(await screen.findByText('auth.forgot.sentTitle')).toBeTruthy();
    expect(accountsFetch).toHaveBeenCalledWith('/password/forgot', {
      json: { email: 'owner@shop.test' },
    });
  });

  it('an invalid address is caught before any request', () => {
    renderPage();
    submit('not-an-email');
    expect(screen.getByText('auth.forgot.emailInvalid')).toBeTruthy();
    expect(accountsFetch).not.toHaveBeenCalled();
  });

  it('a 429 reads as rate-limited and stays on the form', async () => {
    const { AccountsError } = await import('../../lib/accounts');
    accountsFetch.mockRejectedValue(new AccountsError(429, 'TOO_MANY_ATTEMPTS', 'x'));
    renderPage();
    submit('owner@shop.test');
    expect(await screen.findByText('auth.forgot.rateLimited')).toBeTruthy();
    expect(screen.queryByText('auth.forgot.sentTitle')).toBeNull();
  });

  it('links back to sign in', () => {
    renderPage();
    expect(screen.getByText('auth.forgot.backToLogin').closest('a')?.getAttribute('href')).toBe(
      '/login'
    );
  });
});
