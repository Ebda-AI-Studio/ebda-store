// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const submitContact = vi.fn(async (..._a: unknown[]) => ({
  success: true,
  data: { message: 'ok' },
}));
vi.mock('@/lib/api', () => ({ api: { submitContact: (...a: unknown[]) => submitContact(...a) } }));
vi.mock('../../components', () => ({
  ShopChrome: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('@ebda/ui', () => ({
  Button: ({
    children,
    isLoading: _l,
    ...p
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { isLoading?: boolean }) => (
    <button {...p}>{children}</button>
  ),
  Input: ({ label, ...p }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) => (
    <label>
      {label}
      <input {...p} />
    </label>
  ),
  Textarea: ({
    label,
    ...p
  }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) => (
    <label>
      {label}
      <textarea {...p} />
    </label>
  ),
  useToast: () => toast,
}));
vi.mock('../../contexts/StoreContext', () => ({
  useStore: () => ({ store: { name: 'S', settings: {}, email: null, phone: null, address: null } }),
}));
vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'ar', isRtl: true, t: (_en: string, ar: string) => ar }),
  translations: { Email: 'البريد' } as Record<string, string>,
}));
vi.mock('../../templates/shared/display-helpers', () => ({ resolveAddressHref: () => null }));

import ContactClient from './ContactClient';

afterEach(cleanup);

describe('storefront contact form (FU46-1)', () => {
  it('carries a hidden company_site honeypot, out of the tab order', () => {
    const { container } = render(<ContactClient />);
    const trap = container.querySelector('input[name="company_site"]') as HTMLInputElement;
    expect(trap).not.toBeNull();
    expect(trap.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(trap.tabIndex).toBe(-1);
    expect(trap.getAttribute('autocomplete')).toBe('off');
  });

  it('sends the honeypot value and shows the Arabic success toast', async () => {
    render(<ContactClient />);
    fireEvent.change(screen.getByLabelText('الاسم'), { target: { value: 'منى' } });
    fireEvent.change(screen.getByLabelText('البريد الإلكتروني'), {
      target: { value: 'mona@example.test' },
    });
    fireEvent.change(screen.getByLabelText('الموضوع'), { target: { value: 'مقاس' } });
    fireEvent.change(screen.getByLabelText('الرسالة'), { target: { value: 'عندكم M؟' } });
    fireEvent.submit(screen.getByRole('button', { name: 'إرسال رسالة' }).closest('form')!);
    await waitFor(() => expect(submitContact).toHaveBeenCalled());
    expect(submitContact).toHaveBeenCalledWith({
      name: 'منى',
      email: 'mona@example.test',
      subject: 'مقاس',
      message: 'عندكم M؟',
      company_site: '',
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('تم إرسال رسالتك', expect.any(String))
    );
  });
});
