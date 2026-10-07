// @vitest-environment jsdom
/**
 * Reset-password page: reads the emailed token once, strips it from the URL,
 * enforces the signup password policy + confirmation client-side, and maps the
 * API's answers to the right screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

const { apiPost, push, replace } = vi.hoisted(() => ({
  apiPost: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ apiPost }));
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

const TOKEN = 'a'.repeat(64);
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
  it('removes the token from the address bar on load', async () => {
    visit(`?token=${TOKEN}`);
    renderPage();
    await screen.findByLabelText('auth.reset.password');
    expect(window.location.search).toBe('');
    expect(window.location.href).not.toContain(TOKEN);
  });

  it('posts token + password and lands on the success screen with a sign-in action', async () => {
    visit(`?token=${TOKEN}`);
    apiPost.mockResolvedValue({ data: { message: 'ok' }, error: null });
    renderPage();
    await fill(STRONG);
    expect(await screen.findByText('auth.reset.successTitle')).toBeTruthy();
    expect(apiPost).toHaveBeenCalledWith('/api/v1/auth/reset-password', {
      token: TOKEN,
      password: STRONG,
    });
    fireEvent.click(screen.getByRole('button', { name: 'auth.reset.signIn' }));
    expect(replace).toHaveBeenCalledWith('/login');
  });

  it('refuses a weak password and a mismatch before any request', async () => {
    visit(`?token=${TOKEN}`);
    renderPage();
    await fill('weakpass');
    expect(screen.getByText('auth.reset.passwordWeak')).toBeTruthy();
    await fill(STRONG, `${STRONG}x`);
    expect(screen.getByText('auth.reset.mismatch')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it.each([[''], ['?token=abc'], ['?token=' + 'Z'.repeat(64)]])(
    'a missing or malformed token (%s) shows the invalid-link screen without calling the API',
    async search => {
      visit(search);
      renderPage();
      expect(await screen.findByText('auth.reset.invalidTitle')).toBeTruthy();
      expect(apiPost).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'auth.reset.requestNew' }));
      expect(push).toHaveBeenCalledWith('/forgot-password');
    }
  );

  it('a used / expired token (TOKEN_INVALID) shows the invalid-link screen', async () => {
    visit(`?token=${TOKEN}`);
    apiPost.mockResolvedValue({
      data: null,
      error: { code: 'TOKEN_INVALID', message: 'x', status: 400 },
    });
    renderPage();
    await fill(STRONG);
    expect(await screen.findByText('auth.reset.invalidTitle')).toBeTruthy();
  });

  it('a 429 keeps the form with a rate-limit message', async () => {
    visit(`?token=${TOKEN}`);
    apiPost.mockResolvedValue({
      data: null,
      error: { code: 'RATE_LIMITED', message: 'x', status: 429 },
    });
    renderPage();
    await fill(STRONG);
    expect(await screen.findByText('auth.reset.rateLimited')).toBeTruthy();
    expect(screen.getByLabelText('auth.reset.password')).toBeTruthy();
  });
});
