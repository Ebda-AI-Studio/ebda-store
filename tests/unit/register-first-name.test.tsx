// @vitest-environment jsdom
/**
 * QA P2-1: the storefront sign-up first name was reported cleared. Every field now writes through the functional updater, so
 * several change events landing in ONE batch (autofill, a fast typist, a password manager) cannot overwrite a sibling field
 * with a stale copy, and the submit button waits for hydration.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const register = vi.fn(async () => ({ success: true }));
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
  useLanguage: () => ({ t: (en: string) => en }),
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
    submit: async (fn: () => Promise<void>) => fn(),
  }),
}));
vi.mock('@ebda/ui', () => ({
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

import RegisterClient from '../../apps/web/src/app/auth/register/RegisterClient';

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
});
