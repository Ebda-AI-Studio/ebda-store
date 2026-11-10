// @vitest-environment jsdom
/**
 * Verify-email page (identity service): the emailed link carries the address in the query and a one-time code in the
 * fragment; verifying also needs the password chosen at signup, so the page asks for it and POSTs once per submit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

const { accountsFetch, apiPost } = vi.hoisted(() => ({ accountsFetch: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../lib/api', () => ({ apiPost }));
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
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ isAuthenticated: false }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
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

import VerifyEmailPage from './page';

const EMAIL = 'owner@shop.test';
const LINK = `?email=${encodeURIComponent(EMAIL)}#code=123456`;

function visit(search: string) {
  window.history.pushState({}, '', `/verify-email${search}`);
}

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={{}}>
      <VerifyEmailPage />
    </NextIntlClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('verify-email page', () => {
  it('strips the address and code from the address bar, asks for the password, then verifies once', async () => {
    visit(LINK);
    accountsFetch.mockResolvedValue({ verified: true });
    renderPage();
    const pw = await screen.findByLabelText('onboarding.verify.password');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('');
    expect(accountsFetch).not.toHaveBeenCalled(); // nothing is sent until the visitor types the password
    fireEvent.change(pw, { target: { value: 'Str0ng!Passw0rd' } });
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.verify.verifyButton' }));
    expect(await screen.findByText('onboarding.verify.successTitle')).toBeTruthy();
    expect(accountsFetch).toHaveBeenCalledTimes(1);
    expect(accountsFetch).toHaveBeenCalledWith('/otp/verify', {
      json: { email: EMAIL, code: '123456', password: 'Str0ng!Passw0rd' },
    });
  });

  it('PRE-8: the password step says what to do when the link was opened on another device (reset also confirms)', async () => {
    visit(LINK);
    renderPage();
    await screen.findByLabelText('onboarding.verify.password');
    expect(screen.getByTestId('verify-password-hint').textContent).toBe(
      'onboarding.verify.passwordHint'
    );
    expect(
      screen.getByRole('link', { name: 'onboarding.verify.forgotPassword' }).getAttribute('href')
    ).toBe('/forgot-password');
  });

  it('PRE-8: the hint copy exists in Arabic and English and points at the forgot-password link', async () => {
    const ar = (await import('../../i18n/messages/ar.json')).default.onboarding.verify;
    const en = (await import('../../i18n/messages/en.json')).default.onboarding.verify;
    expect(ar.passwordHint).toContain(ar.forgotPassword);
    expect(en.passwordHint).toContain(en.forgotPassword);
  });

  it('a wrong password keeps the form with a message and offers forgot-password', async () => {
    visit(LINK);
    const { AccountsError } = await import('../../lib/accounts');
    accountsFetch.mockRejectedValue(new AccountsError(400, 'INVALID_CODE', 'x'));
    renderPage();
    fireEvent.change(await screen.findByLabelText('onboarding.verify.password'), {
      target: { value: 'nope' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.verify.verifyButton' }));
    expect(await screen.findByText('onboarding.verify.wrongPassword')).toBeTruthy();
    expect(
      screen.getByText('onboarding.verify.forgotPassword').closest('a')?.getAttribute('href')
    ).toBe('/forgot-password');
  });

  it.each([[''], ['?email=a%40b.test'], ['#code=123456'], ['?email=a%40b.test#code=12']])(
    'an incomplete link (%s) never calls the identity service',
    async search => {
      visit(search);
      renderPage();
      expect(await screen.findByText('onboarding.verify.missing')).toBeTruthy();
      await waitFor(() => expect(accountsFetch).not.toHaveBeenCalled());
    }
  );
});

describe('verify-email page, throttled (UX:S-5)', () => {
  it('a 429 on verify names the rate limit', async () => {
    visit(LINK);
    const { AccountsError } = await import('../../lib/accounts');
    accountsFetch.mockRejectedValue(new AccountsError(429, 'THROTTLED', 'x'));
    renderPage();
    fireEvent.change(await screen.findByLabelText('onboarding.verify.password'), {
      target: { value: 'Str0ng!Passw0rd' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.verify.verifyButton' }));
    expect(await screen.findByText('onboarding.verify.rateLimited')).toBeTruthy();
  });

  it('a 429 on resend says so instead of claiming the link was sent', async () => {
    visit('');
    apiPost.mockResolvedValue({ error: { code: 'RATE_LIMITED', status: 429, message: 'x' } });
    renderPage();
    await screen.findByText('onboarding.verify.missing');
    fireEvent.change(screen.getByLabelText('onboarding.verify.email'), {
      target: { value: 'a@b.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.verify.resend' }));
    expect(await screen.findByText('onboarding.verify.rateLimited')).toBeTruthy();
    expect(screen.queryByText('onboarding.verify.resent')).toBeNull();
  });
});
