// @vitest-environment jsdom
/**
 * QA P2-1: the storefront sign-up first name was reported cleared. Every field now writes through the functional updater, so
 * several change events landing in ONE batch (autofill, a fast typist, a password manager) cannot overwrite a sibling field
 * with a stale copy, and the submit button waits for hydration.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const register = vi.fn(
  async (..._a: unknown[]): Promise<Record<string, unknown>> => ({ success: true })
);
const ui = vi.hoisted(() => ({ lang: 'en' as 'en' | 'ar', lastError: '' }));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: { register: (...a: unknown[]) => register(...(a as [])) },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../../apps/web/src/components/StoreLink', () => ({
  default: (p: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...p} />,
}));
vi.mock('../../apps/web/src/components', () => ({
  MinimalChrome: (p: { children: React.ReactNode }) => <div>{p.children}</div>,
}));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStoreUrl: () => (p: string) => p,
  useStore: () => ({ store: { id: 'store-1' } }),
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: ui.lang,
    t: (en: string, ar: string) => (ui.lang === 'ar' ? ar : en),
  }),
}));
vi.mock('../../apps/web/src/app/auth/register/validate-registration', () => ({
  validateRegistration: () => null,
}));
vi.mock('../../apps/web/src/lib/demo-refusal', () => ({ demoRefusalText: () => '' }));
vi.mock('../../apps/web/src/hooks/useAuthFormSubmit', () => ({
  useAuthFormSubmit: () => ({
    isLoading: false,
    error: '',
    setError: vi.fn(),
    submit: async (fn: () => Promise<void>) => {
      try {
        await fn();
        return true;
      } catch (e) {
        ui.lastError = (e as Error).message;
        return false;
      }
    },
  }),
}));
vi.mock('@ebda/ui', () => ({
  PasswordRules: () => null,
  Input: ({ label, ...p }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) => (
    <label>
      {label}
      <input aria-label={label} {...p} />
    </label>
  ),
  Button: ({
    isLoading: _l,
    ...p
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { isLoading?: boolean }) => <button {...p} />,
}));

import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import RegisterClient from '../../apps/web/src/app/auth/register/RegisterClient';

beforeEach(() => {
  ui.lang = 'en';
  ui.lastError = '';
  register.mockClear();
});

describe('storefront register form', () => {
  it('keeps every field when several change events land in one batch', async () => {
    render(<RegisterClient />);
    const first = screen.getByLabelText('First name') as HTMLInputElement;
    const last = screen.getByLabelText('Last name') as HTMLInputElement;
    const email = screen.getByLabelText('Email address') as HTMLInputElement;
    act(() => {
      fireEvent.change(first, { target: { value: 'Sara' } });
      fireEvent.change(last, { target: { value: 'Ali' } });
      fireEvent.change(email, { target: { value: 'sara@example.test' } });
    });
    expect(first.value).toBe('Sara');
    expect(last.value).toBe('Ali');
    expect(email.value).toBe('sara@example.test');
  });

  it('submits the typed first name', async () => {
    render(<RegisterClient />);
    const set = (label: string, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    set('First name', 'Sara');
    set('Last name', 'Ali');
    set('Email address', 'sara@example.test');
    set('Password', 'Str0ng-pass-word!');
    set('Confirm password', 'Str0ng-pass-word!');
    fireEvent.click(screen.getByRole('checkbox'));
    const button = screen.getByRole('button', { name: 'Create account' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false); // hydrated: effects have run
    fireEvent.submit(button.closest('form')!);
    await waitFor(() => expect(register).toHaveBeenCalled());
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Sara', lastName: 'Ali', storeId: 'store-1' })
    );
  });

  it('keeps a first name typed BEFORE hydration when the shopper moves to the next field (QA P2-1)', async () => {
    const host = document.createElement('div');
    host.innerHTML = renderToString(<RegisterClient />);
    document.body.appendChild(host);
    // The shopper types into the server-rendered input before React has attached.
    const firstSsr = host.querySelector('input[aria-label="First name"]') as HTMLInputElement;
    firstSsr.value = 'سارة';
    await act(async () => {
      hydrateRoot(host, <RegisterClient />);
    });
    const first = host.querySelector('input[aria-label="First name"]') as HTMLInputElement;
    const last = host.querySelector('input[aria-label="Last name"]') as HTMLInputElement;
    act(() => {
      fireEvent.change(last, { target: { value: 'علي' } });
    });
    expect(first.value).toBe('سارة');
    expect(last.value).toBe('علي');
    host.remove();
  });

  it('a throttled sign-up reads Egyptian Arabic, never the API English (QA P2-10 class)', async () => {
    ui.lang = 'ar';
    register.mockResolvedValueOnce({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again.' },
    });
    render(<RegisterClient />);
    const set = (label: string, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    set('الاسم الأول', 'سارة');
    set('اسم العائلة', 'علي');
    set('البريد الإلكتروني', 'sara@example.test');
    set('كلمة المرور', 'Str0ng-pass-word!');
    set('تأكيد كلمة المرور', 'Str0ng-pass-word!');
    fireEvent.submit(screen.getByRole('button', { name: 'إنشاء حساب' }).closest('form')!);
    await waitFor(() => expect(ui.lastError).not.toBe(''));
    expect(ui.lastError).toBe('محاولات كتير. استنى كام دقيقة وجرّب تاني.');
  });

  it('a 400 VALIDATION_ERROR names the failed password rules in Arabic, not the generic text (2026-11-17)', async () => {
    ui.lang = 'ar';
    register.mockResolvedValueOnce({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: {
          password: [
            'Password must contain at least one uppercase letter',
            'Password must contain at least one special character',
          ],
          messageAr: 'في بيانات مش مظبوطة',
        },
      },
    });
    render(<RegisterClient />);
    const set = (label: string, value: string) =>
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    set('الاسم الأول', 'سارة');
    set('اسم العائلة', 'علي');
    set('البريد الإلكتروني', 'sara@example.test');
    set('كلمة المرور', 'Str0ng-pass-word!');
    set('تأكيد كلمة المرور', 'Str0ng-pass-word!');
    fireEvent.submit(screen.getByRole('button', { name: 'إنشاء حساب' }).closest('form')!);
    await waitFor(() => expect(ui.lastError).not.toBe(''));
    expect(ui.lastError).toBe(
      'كلمة المرور لسه محتاجة: حرف إنجليزي كبير (A-Z)، رمز واحد على الأقل زي ! @ # $.'
    );
  });
});
