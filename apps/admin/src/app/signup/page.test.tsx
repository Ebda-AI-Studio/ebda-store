// @vitest-environment jsdom
/**
 * Public signup page (SP5 task 2): client validation mirrors the API, the
 * request carries only what was entered, and the confirmation never says
 * whether the address already had an account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiPost, apiGet, replace } = vi.hoisted(() => ({
  apiPost: vi.fn(),
  apiGet: vi.fn(),
  replace: vi.fn(),
}));
vi.mock('../../lib/api', async importActual => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  apiPost,
  apiGet,
}));
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ isAuthenticated: false, isLoading: false }),
}));
const localeRef = vi.hoisted(() => ({ value: 'en' }));
vi.mock('next-intl', () => ({ useLocale: () => localeRef.value }));
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

beforeEach(() => {
  apiGet.mockResolvedValue({ data: { token: 'tok-1' }, error: null });
});

afterEach(() => {
  localeRef.value = 'en';
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
const submit = (opts: { agree?: boolean } = {}) => {
  const box = screen.getByRole('checkbox') as HTMLInputElement;
  if ((opts.agree ?? true) && !box.checked) fireEvent.click(box);
  fireEvent.click(screen.getByRole('button', { name: 'onboarding.signup.submit' }));
};

const LEGAL_PATHS =
  /^https:\/\/ebda\.app(\/en)?\/(terms|privacy|merchant-agreement|acceptable-use|legal)\/$/;

describe('signup page', () => {
  it('blocks submit until the policies are accepted, focuses the checkbox, and links all five documents', async () => {
    render(<SignupPage />);
    fill({ name: 'Mona', email: 'mona@x.com', phone: '01012345678', password: 'Str0ng!Passw0rd' });
    submit({ agree: false });
    expect(await screen.findByText('onboarding.signup.errors.legalRequired')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('checkbox'));
    const hrefs = screen.getAllByRole('link').map(a => a.getAttribute('href'));
    expect(hrefs).toEqual(
      expect.arrayContaining([
        'https://ebda.app/en/terms/',
        'https://ebda.app/en/privacy/',
        'https://ebda.app/en/merchant-agreement/',
        'https://ebda.app/en/acceptable-use/',
        'https://ebda.app/en/legal/',
      ])
    );
    expect(screen.getByText('Terms of service')).toBeTruthy();
    expect(screen.getByText('Legal notice')).toBeTruthy();
  });

  it('links the Arabic documents with their Arabic titles in the ar locale', () => {
    localeRef.value = 'ar';
    render(<SignupPage />);
    const links = screen
      .getAllByRole('link')
      .filter(a => LEGAL_PATHS.test(a.getAttribute('href') ?? ''));
    expect(links.map(a => a.getAttribute('href'))).toEqual([
      'https://ebda.app/terms/',
      'https://ebda.app/privacy/',
      'https://ebda.app/merchant-agreement/',
      'https://ebda.app/acceptable-use/',
      'https://ebda.app/legal/',
    ]);
    expect(links.map(a => a.textContent)).toEqual([
      'شروط الخدمة',
      'سياسة الخصوصية',
      'اتفاقية التاجر',
      'سياسة الاستخدام المقبول',
      'الإشعار القانوني',
    ]);
  });

  it('blocks an empty mobile number before submitting', async () => {
    render(<SignupPage />);
    fill({ name: 'Mona', email: 'mona@x.com', phone: '', password: 'Str0ng!Passw0rd' });
    submit();
    expect(await screen.findByText('onboarding.signup.errors.phoneRequired')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
    expect(screen.getByLabelText('onboarding.signup.phone').hasAttribute('required')).toBe(true);
  });
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
    await act(async () => {}); // let the form-token fetch settle
    fill({
      name: ' Mona Hassan ',
      email: 'mona@x.com',
      phone: '01012345678',
      password: 'Str0ng!Passw0rd',
    });
    submit();
    expect(
      await screen.findByText('onboarding.signup.sent.body:{"email":"mona@x.com"}')
    ).toBeTruthy();
    // Required phone is sent, name is trimmed.
    expect(apiPost).toHaveBeenCalledWith('/api/v1/auth/merchant/signup', {
      email: 'mona@x.com',
      password: 'Str0ng!Passw0rd',
      name: 'Mona Hassan',
      phone: '01012345678',
      language: 'en',
      // Abuse controls: the server-signed form token and an EMPTY honeypot.
      formToken: 'tok-1',
      company_site: '',
      acceptedLegal: true,
    });
  });

  it('sends a valid required phone as typed (the API normalises it)', async () => {
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
    fill({ name: 'Mona', email: 'mona@x.com', phone: '01012345678', password: 'Str0ng!Passw0rd' });
    submit();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('onboarding.signup.errors.rateLimited')).toBeTruthy();
  });

  it('maps a disposable-domain refusal to the email field', async () => {
    apiPost.mockResolvedValue({
      data: null,
      error: { code: 'EMAIL_DOMAIN_NOT_ALLOWED', message: 'x', status: 400 },
    });
    render(<SignupPage />);
    fill({
      name: 'Mona',
      email: 'mona@mailinator.com',
      phone: '01012345678',
      password: 'Str0ng!Passw0rd',
    });
    submit();
    expect(await screen.findByText('onboarding.signup.errors.emailDisposable')).toBeTruthy();
  });

  it('maps an API VALIDATION_ERROR field to that field, not the generic line', async () => {
    apiPost.mockResolvedValue({
      data: null,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'x',
        status: 400,
        details: { phone: ['Invalid phone'] },
      },
    });
    render(<SignupPage />);
    fill({ name: 'Mona', email: 'mona@x.com', phone: '01012345678', password: 'Str0ng!Passw0rd' });
    submit();
    expect(await screen.findByText('onboarding.signup.errors.phoneInvalid')).toBeTruthy();
    expect(screen.queryByText('onboarding.signup.errors.generic')).toBeNull();
  });

  it('refetches the form token after a too-fast / expired refusal', async () => {
    apiPost.mockResolvedValue({
      data: null,
      error: { code: 'SIGNUP_TOO_FAST', message: 'x', status: 400 },
    });
    render(<SignupPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    fill({ name: 'Mona', email: 'mona@x.com', phone: '01012345678', password: 'Str0ng!Passw0rd' });
    submit();
    expect(await screen.findByText('onboarding.signup.errors.tooFast')).toBeTruthy();
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
  });

  it('resend goes to the generic resend endpoint', async () => {
    apiPost.mockResolvedValue({ data: { emailVerificationSent: true }, error: null });
    render(<SignupPage />);
    fill({ name: 'Mona', email: 'mona@x.com', phone: '01012345678', password: 'Str0ng!Passw0rd' });
    submit();
    fireEvent.click(await screen.findByRole('button', { name: 'onboarding.signup.sent.resend' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenLastCalledWith('/api/v1/auth/merchant/resend-verification', {
        email: 'mona@x.com',
      })
    );
  });
});

it('reports a failed resend without a success message', async () => {
  apiPost.mockResolvedValueOnce({ data: { emailVerificationSent: true }, error: null });
  apiPost.mockResolvedValueOnce({ data: null, error: { status: 503, code: 'UNAVAILABLE' } });
  render(<SignupPage />);
  fill({ name: 'Mona', email: 'mona@x.com', phone: '01012345678', password: 'Str0ng!Passw0rd' });
  submit();
  fireEvent.click(await screen.findByRole('button', { name: 'onboarding.signup.sent.resend' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'onboarding.signup.errors.generic'
  );
  expect(screen.queryByText('onboarding.signup.sent.resent')).toBeNull();
});

describe('signup plan hand-off from the marketing site', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    // This jsdom origin has no localStorage; a Map-backed stand-in.
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
  });
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('keeps a valid ?plan&interval for onboarding and shows it back', async () => {
    window.history.replaceState(null, '', '/signup?plan=business&interval=year');
    render(<SignupPage />);
    const chip = await screen.findByTestId('selected-plan');
    expect(chip.textContent).toBe(
      'onboarding.signup.plan.chip:{"plan":"Business","interval":"onboarding.signup.plan.yearly","trialPlan":"Growth"}'
    );
    expect(JSON.parse(window.localStorage.getItem('ebda.signup.plan')!)).toEqual({
      planCode: 'business',
      interval: 'yearly',
    });
  });

  it('defaults a missing interval to monthly', async () => {
    window.history.replaceState(null, '', '/signup?plan=basic');
    render(<SignupPage />);
    await screen.findByTestId('selected-plan');
    expect(JSON.parse(window.localStorage.getItem('ebda.signup.plan')!)).toEqual({
      planCode: 'basic',
      interval: 'monthly',
    });
  });

  it('ignores an unknown plan: no chip, nothing stored', async () => {
    window.history.replaceState(null, '', '/signup?plan=enterprise&interval=year');
    render(<SignupPage />);
    await act(async () => {});
    expect(screen.queryByTestId('selected-plan')).toBeNull();
    expect(window.localStorage.getItem('ebda.signup.plan')).toBeNull();
  });
});
