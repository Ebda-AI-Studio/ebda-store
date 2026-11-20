// @vitest-environment jsdom
/** QA-81: the one super-admin suspend / reinstate control: required reason, in-page confirm, errors shown. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ar from '@/i18n/messages/ar.json';

const lookup = (o: unknown, path: string) =>
  path.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown>)?.[k], o) as string;
vi.mock('@/i18n/useT', () => ({
  useT: (ns: string) => (k: string, v?: Record<string, string>) => {
    const s = lookup(ar, `${ns}.${k}`) ?? `${ns}.${k}`;
    return v ? s.replace(/\{(\w+)\}/g, (_m, n) => v[n]) : s;
  },
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
const toastSuccess = vi.fn();
vi.mock('@ebda/ui', () => ({
  Modal: ({
    isOpen,
    children,
    title,
  }: {
    isOpen: boolean;
    children: React.ReactNode;
    title?: string;
  }) =>
    isOpen ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
  useToast: () => ({ success: toastSuccess }),
  cn: (...a: string[]) => a.filter(Boolean).join(' '),
}));
const apiPatch = vi.fn();
vi.mock('@/lib/api', () => ({ apiPatch: (...a: unknown[]) => apiPatch(...a) }));

import { StoreStatusControl } from './StoreStatusControl';

const confirm = vi.spyOn(window, 'confirm');
const mount = (status: string, onChanged = vi.fn()) => {
  render(
    <StoreStatusControl storeId="s1" storeName="متجر ليلى" status={status} onChanged={onChanged} />
  );
  return onChanged;
};
const T = (k: string) => lookup(ar, `storeStatus.${k}`);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StoreStatusControl', () => {
  it('offers Suspend for an active AND an inactive store (QA-81: inactive had no suspend)', () => {
    for (const status of ['active', 'inactive']) {
      mount(status);
      expect(screen.getByRole('button', { name: T('suspendTitle') })).toBeTruthy();
      expect(screen.queryByRole('button', { name: T('reinstateTitle') })).toBeNull();
      cleanup();
    }
  });

  it('refuses to suspend without a reason: no request, the field says why', async () => {
    mount('active');
    fireEvent.click(screen.getByRole('button', { name: T('suspendTitle') }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: T('suspendConfirm') })
    );
    expect(apiPatch).not.toHaveBeenCalled();
    const field = screen.getByLabelText(T('reasonLabel'));
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(T('reasonRequired'))).toBeTruthy();
    // whitespace is not a reason
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: T('suspendConfirm') })
    );
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it('suspends with the trimmed reason, confirms in the page (no window.confirm) and reloads', async () => {
    apiPatch.mockResolvedValue({ data: {}, error: null });
    const onChanged = mount('active');
    fireEvent.click(screen.getByRole('button', { name: T('suspendTitle') }));
    fireEvent.change(screen.getByLabelText(T('reasonLabel')), {
      target: { value: '  مخالفة سياسة الاستخدام  ' },
    });
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: T('suspendConfirm') })
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(apiPatch).toHaveBeenCalledWith('/api/v1/stores/s1/status', {
      status: 'suspended',
      reason: 'مخالفة سياسة الاستخدام',
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the failure inside the dialog and does not reload when the API refuses', async () => {
    apiPatch.mockResolvedValue({ data: null, error: { message: 'x', status: 500 } });
    const onChanged = mount('active');
    fireEvent.click(screen.getByRole('button', { name: T('suspendTitle') }));
    fireEvent.change(screen.getByLabelText(T('reasonLabel')), { target: { value: 'سبب' } });
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: T('suspendConfirm') })
    );
    expect((await screen.findByRole('alert')).textContent).toBe(T('failed'));
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('a suspended store offers Reinstate (confirm in page, no reason sent) and links to the appeals', async () => {
    apiPatch.mockResolvedValue({ data: {}, error: null });
    const onChanged = mount('suspended');
    expect(screen.queryByRole('button', { name: T('suspendTitle') })).toBeNull();
    expect(screen.getByRole('link', { name: T('appealsLink') }).getAttribute('href')).toBe(
      '/trust-requests'
    );
    fireEvent.click(screen.getByRole('button', { name: T('reinstateTitle') }));
    expect(apiPatch).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: T('reinstateConfirm') })
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(apiPatch).toHaveBeenCalledWith('/api/v1/stores/s1/status', { status: 'active' });
    expect(confirm).not.toHaveBeenCalled();
  });
});
