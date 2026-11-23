// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ar from '../../i18n/messages/ar.json';

const { apiGet, apiPost, auth } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  auth: { user: { role: 'store_admin' } as { role: string } | null },
}));
vi.mock('next-intl', () => ({ useLocale: () => 'ar' }));
vi.mock('../../lib/api', () => ({ apiGet, apiPost }));
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ user: auth.user }) }));
vi.mock('@/components/ui/Button', () => ({
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
}));
vi.mock('../../i18n/useT', () => ({
  useT: (ns: string) => (k: string, v?: Record<string, string>) => {
    let o: unknown = ar as unknown;
    for (const part of `${ns}.${k}`.split('.')) o = (o as Record<string, unknown>)?.[part];
    const s = typeof o === 'string' ? o : k;
    return v ? s.replace(/\{(\w+)\}/g, (_m, n) => v[n] ?? '') : s;
  },
}));

import { OwnerConsentGate } from './OwnerConsentGate';

const docs = [
  {
    docKey: 'terms',
    version: '1.2',
    title: { ar: 'شروط الخدمة', en: 'Terms of service' },
    url: { ar: 'https://ebda.app/terms/', en: 'https://ebda.app/en/terms/' },
  },
  {
    docKey: 'privacy',
    version: '1.3',
    title: { ar: 'سياسة الخصوصية', en: 'Privacy policy' },
    url: { ar: 'https://ebda.app/privacy/', en: 'https://ebda.app/en/privacy/' },
  },
];

beforeEach(() => {
  auth.user = { role: 'store_admin' };
  apiGet.mockResolvedValue({ data: { consent: { required: true, documents: docs } } });
  apiPost.mockResolvedValue({ data: { recorded: 2 }, error: null });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OwnerConsentGate', () => {
  it('blocks an owner with no record: both documents linked, an unticked box, agree disabled', async () => {
    render(<OwnerConsentGate />);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('شروط الخدمة').getAttribute('href')).toBe('https://ebda.app/terms/');
    expect(screen.getByText('سياسة الخصوصية').getAttribute('href')).toBe(
      'https://ebda.app/privacy/'
    );
    const box = screen.getByLabelText('قريت ووافقت على الشروط وسياسة الخصوصية') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect((screen.getByRole('button', { name: 'أوافق' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('cannot be dismissed with Escape', async () => {
    render(<OwnerConsentGate />);
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('ticking then agreeing posts accepted:true and removes the modal', async () => {
    render(<OwnerConsentGate />);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByLabelText('قريت ووافقت على الشروط وسياسة الخصوصية'));
    fireEvent.click(screen.getByRole('button', { name: 'أوافق' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(apiPost).toHaveBeenCalledWith('/api/v1/me/legal-notices/accept', { accepted: true });
  });

  it('a failed save keeps the modal and says so', async () => {
    apiPost.mockResolvedValue({ data: null, error: { code: 'X', message: 'x', status: 500 } });
    render(<OwnerConsentGate />);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByLabelText('قريت ووافقت على الشروط وسياسة الخصوصية'));
    fireEvent.click(screen.getByRole('button', { name: 'أوافق' }));
    expect((await screen.findByRole('alert')).textContent).toContain('ماقدرناش');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows nothing for an owner who has accepted, and never asks staff or a super admin', async () => {
    apiGet.mockResolvedValue({ data: { consent: { required: false, documents: [] } } });
    const { container } = render(<OwnerConsentGate />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
    cleanup();
    apiGet.mockClear();
    auth.user = { role: 'staff' };
    render(<OwnerConsentGate />);
    expect(apiGet).not.toHaveBeenCalled();
  });
});
