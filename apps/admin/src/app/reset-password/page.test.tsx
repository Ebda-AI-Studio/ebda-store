// @vitest-environment jsdom
/**
 * Reset-password page: reads the emailed token once, strips it from the URL,
 * enforces the signup password policy + confirmation client-side, and maps the
 * API's answers to the right screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

const { accountsFetch, push, replace } = vi.hoisted(() => ({
  accountsFetch: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
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

vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace }) }));
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

import ResetPasswordPage from './page';

const EMAIL = 'owner@shop.test';
const CODE = '123456';
/** The emailed link: the address in the query, the code in the fragment. */
const LINK = `?email=${encodeURIComponent(EMAIL)}#code=${CODE}`;
const STRONG = 'N3w!Passw0rd';

function visit(search: string) {
  window.history.pushState({}, '', `/reset-password${search}`);
}

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={{}}>
      <ResetPasswordPage />
    </NextIntlClientProvider>
  );
}

async function fill(password: string, confirm = password) {
  fireEvent.change(await screen.findByLabelText('auth.reset.password'), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText('auth.reset.confirm'), { target: { value: confirm } });
  fireEvent.click(screen.getByRole('button', { name: 'auth.reset.submit' }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('reset-password page', () => {
  it('removes the address and the code from the address bar on load', async () => {
    visit(LINK);
    renderPage();
    await screen.findByLabelText('auth.reset.password');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(CODE);
  });

  it('posts email + code + new password to the identity service and lands on the success screen', async () => {
    visit(LINK);
    accountsFetch.mockResolvedValue({ reset: true });
    renderPage();
    await fill(STRONG);
    expect(await screen.findByText('auth.reset.successTitle')).toBeTruthy();
    expect(accountsFetch).toHaveBeenCalledWith('/password/reset', {
      json: { email: EMAIL, code: CODE, newPassword: STRONG },
    });
    fireEvent.click(screen.getByRole('button', { name: 'auth.reset.signIn' }));
    expect(replace).toHaveBeenCalledWith('/login');
  });

  it('refuses a weak password and a mismatch before any request', async () => {
    visit(LINK);
    renderPage();
    await fill('weakpass');
    expect(screen.getByText('auth.reset.passwordWeak')).toBeTruthy();
    await fill(STRONG, `${STRONG}x`);
    expect(screen.getByText('auth.reset.mismatch')).toBeTruthy();
    expect(accountsFetch).not.toHaveBeenCalled();
  });

  it.each([[''], ['?email=a%40b.test#code=abc'], ['#code=123456'], ['?email=a%40b.test']])(
    'a missing or malformed link (%s) shows the invalid-link screen without calling the API',
    async search => {
      visit(search);
      renderPage();
      expect(await screen.findByText('auth.reset.invalidTitle')).toBeTruthy();
      expect(accountsFetch).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'auth.reset.requestNew' }));
      expect(push).toHaveBeenCalledWith('/forgot-password');
    }
  );

  it('a used / expired code (INVALID_CODE) shows the invalid-link screen', async () => {
    visit(LINK);
    const { AccountsError } = await import('../../lib/accounts');
    accountsFetch.mockRejectedValue(new AccountsError(400, 'INVALID_CODE', 'x'));
    renderPage();
    await fill(STRONG);
    expect(await screen.findByText('auth.reset.invalidTitle')).toBeTruthy();
  });

  it('a REMOUNT after the address bar was cleaned keeps the form, and the submit sends the original link (2026-11-18)', async () => {
    visit(LINK);
    accountsFetch.mockResolvedValue({ reset: true });
    const first = renderPage();
    await screen.findByLabelText('auth.reset.password');
    expect(window.location.search).toBe('');
    // Next re-creates the page segment for the cleaned URL (it landed on the first keystroke): a fresh instance
    first.unmount();
    renderPage();
    fireEvent.change(await screen.findByLabelText('auth.reset.password'), {
      target: { value: 'N' },
    });
    expect(screen.queryByText('auth.reset.invalidTitle')).toBeNull();
    await fill(STRONG);
    expect(accountsFetch).toHaveBeenCalledWith('/password/reset', {
      json: { email: EMAIL, code: CODE, newPassword: STRONG },
    });
    expect(await screen.findByText('auth.reset.successTitle')).toBeTruthy();
  });

  it('the captured link is cleared after a success and after a used code; a new visit without a link is invalid', async () => {
    visit(LINK);
    accountsFetch.mockResolvedValue({ reset: true });
    const a = renderPage();
    await fill(STRONG);
    await screen.findByText('auth.reset.successTitle');
    a.unmount();
    renderPage(); // same entry, after success: nothing to reuse
    expect(await screen.findByText('auth.reset.invalidTitle')).toBeTruthy();
    cleanup();

    visit(LINK);
    const { AccountsError } = await import('../../lib/accounts');
    accountsFetch.mockRejectedValue(new AccountsError(400, 'INVALID_CODE', 'x'));
    const b = renderPage();
    await fill(STRONG);
    await screen.findByText('auth.reset.invalidTitle');
    b.unmount();
    renderPage(); // same entry, after a used code
    expect(await screen.findByText('auth.reset.invalidTitle')).toBeTruthy();
    cleanup();

    visit(LINK); // opened, not submitted
    const c = renderPage();
    await screen.findByLabelText('auth.reset.password');
    c.unmount();
    visit(''); // a later, separate visit with no link
    renderPage();
    expect(await screen.findByText('auth.reset.invalidTitle')).toBeTruthy();
  });

  it('a 429 keeps the form with a rate-limit message', async () => {
    visit(LINK);
    const { AccountsError } = await import('../../lib/accounts');
    accountsFetch.mockRejectedValue(new AccountsError(429, 'TOO_MANY_ATTEMPTS', 'x'));
    renderPage();
    await fill(STRONG);
    expect(await screen.findByText('auth.reset.rateLimited')).toBeTruthy();
    expect(screen.getByLabelText('auth.reset.password')).toBeTruthy();
  });
});
