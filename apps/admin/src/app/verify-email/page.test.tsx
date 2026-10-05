// @vitest-environment jsdom
/**
 * Verify-email page (SP5 task 2): the emailed token is single-use, so the page
 * must POST it exactly once, and each failure reads distinctly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));
vi.mock('../../lib/api', () => ({ apiPost }));
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

function visit(search: string) {
  window.history.pushState({}, '', `/verify-email${search}`);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('verify-email page', () => {
  it('posts the token once and shows success', async () => {
    visit('?token=abc123');
    apiPost.mockResolvedValue({ data: { success: true }, error: null });
    render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <VerifyEmailPage />
      </NextIntlClientProvider>
    );
    expect(await screen.findByText('onboarding.verify.successTitle')).toBeTruthy();
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith('/api/v1/auth/verify-email', { token: 'abc123' });
  });

  it.each([
    ['TOKEN_EXPIRED', 'onboarding.verify.expired'],
    ['TOKEN_INVALID', 'onboarding.verify.invalid'],
    ['SERVER_ERROR', 'onboarding.verify.generic'],
  ])('maps %s to its own message and offers a resend form', async (code, text) => {
    visit('?token=abc123');
    apiPost.mockResolvedValue({ data: null, error: { code, message: 'x', status: 400 } });
    render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <VerifyEmailPage />
      </NextIntlClientProvider>
    );
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByLabelText('onboarding.verify.email')).toBeTruthy();
  });

  it('a link with no token never calls the API', async () => {
    visit('');
    render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <VerifyEmailPage />
      </NextIntlClientProvider>
    );
    expect(await screen.findByText('onboarding.verify.missing')).toBeTruthy();
    await waitFor(() => expect(apiPost).not.toHaveBeenCalled());
  });
});
