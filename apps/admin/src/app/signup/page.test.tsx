// @vitest-environment jsdom
/**
 * Public signup page (SP5 task 2): client validation mirrors the API, the
 * request carries only what was entered, and the confirmation never says
 * whether the address already had an account.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiPost, replace } = vi.hoisted(() => ({ apiPost: vi.fn(), replace: vi.fn() }));
vi.mock('../../lib/api', () => ({ apiPost }));
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ isAuthenticated: false, isLoading: false }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('next/image', () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));
vi.mock('@/i18n/useT', () => {
  const useT = (ns?: string) => (key: string, vars?: Record<string, unknown>) =>
    `${ns ? `${ns}.` : ''}${key}${vars ? `:${JSON.stringify(vars)}` : ''}`;
  return { useT };
});

import SignupPage from './page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function fill(values: Partial<Record<'name' | 'email' | 'phone' | 'password', string>>) {
  const map = {
    name: 'onboarding.signup.name',
    email: 'onboarding.signup.email',
    phone: 'onboarding.signup.phone',
    password: 'onboarding.signup.password',
  } as const;
  for (const [k, v] of Object.entries(values)) {
    fireEvent.change(screen.getByLabelText(map[k as keyof typeof map]), { target: { value: v } });
  }
}
const submit = () =>
  fireEvent.click(screen.getByRole('button', { name: 'onboarding.signup.submit' }));

describe('signup page', () => {
  it('validates before calling the API (weak password, bad phone, bad email)', async () => {
    render(<SignupPage />);
    fill({ name: 'Mona', email: 'nope', phone: '123', password: 'weak' });
    submit();
    expect(await screen.findByText('onboarding.signup.errors.emailInvalid')).toBeTruthy();
    expect(screen.getByText('onboarding.signup.errors.passwordWeak')).toBeTruthy();
    expect(screen.getByText('onboarding.signup.errors.phoneInvalid')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('posts the signup and shows the same "check your email" screen regardless of the address', async () => {
    apiPost.mockResolvedValue({ data: { emailVerificationSent: true }, error: null });
    render(<SignupPage />);
    fill({ name: ' Mona Hassan ', email: 'mona@x.com', phone: '', password: 'Str0ng!Passw0rd' });
    submit();
    expect(
      await screen.findByText('onboarding.signup.sent.body:{"email":"mona@x.com"}')
    ).toBeTruthy();
    // Empty optional phone is omitted, name is trimmed.
    expect(apiPost).toHaveBeenCalledWith('/api/v1/auth/merchant/signup', {
      email: 'mona@x.com',
      password: 'Str0ng!Passw0rd',
      name: 'Mona Hassan',
      language: 'en',
    });
  });

  it('sends a valid optional phone as typed (the API normalises it)', async () => {
    apiPost.mockResolvedValue({ data: { emailVerificationSent: true }, error: null });
    render(<SignupPage />);
    fill({
      name: 'Mona',
      email: 'mona@x.com',
      phone: '010 1234 5678',
      password: 'Str0ng!Passw0rd',
    });
    submit();
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost.mock.calls[0][1]).toMatchObject({ phone: '010 1234 5678' });
  });

  it('shows a rate-limit message on 429 and stays on the form', async () => {
    apiPost.mockResolvedValue({
      data: null,
      error: { code: 'RATE_LIMITED', message: 'x', status: 429 },
    });
    render(<SignupPage />);
    fill({ name: 'Mona', email: 'mona@x.com', password: 'Str0ng!Passw0rd' });
    submit();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('onboarding.signup.errors.rateLimited')).toBeTruthy();
  });

  it('resend goes to the generic resend endpoint', async () => {
    apiPost.mockResolvedValue({ data: { emailVerificationSent: true }, error: null });
    render(<SignupPage />);
    fill({ name: 'Mona', email: 'mona@x.com', password: 'Str0ng!Passw0rd' });
    submit();
    fireEvent.click(await screen.findByRole('button', { name: 'onboarding.signup.sent.resend' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenLastCalledWith('/api/v1/auth/merchant/resend-verification', {
        email: 'mona@x.com',
      })
    );
  });
});
