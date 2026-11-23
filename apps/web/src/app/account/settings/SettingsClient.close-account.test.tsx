// @vitest-environment jsdom
/**
 * Close my account: the confirm dialog reads the wallet balance from the SERVER (not the feature-flagged wallet hook), the
 * delete button needs the forfeit acknowledgement while a balance remains, and a refusal code is shown in the shopper's language.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  lang: { current: 'en' as 'en' | 'ar' },
  toastError: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    getProfile: vi.fn(async () => ({ success: false })),
    getSmsConsent: vi.fn(async () => ({ success: false })),
    get: h.get,
    post: h.post,
  },
}));
vi.mock('../../../contexts/LanguageContext', () => ({
  useLanguage: () => ({
    t: (en: string, ar: string) => (h.lang.current === 'ar' ? ar : en),
    language: h.lang.current,
  }),
  translations: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock('../../../contexts/StoreContext', () => ({ useStoreUrl: () => (p: string) => p }));
vi.mock('../../../hooks/useLocalePrice', () => ({
  useLocalePrice: () => (n: number) => `EGP ${n}`,
}));
vi.mock('../../../components/PasskeysCard', () => ({ default: () => null }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@ebda/ui', () => ({
  Button: ({
    isLoading: _l,
    ...p
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { isLoading?: boolean }) => <button {...p} />,
  Input: (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} />,
  useToast: () => ({ success: vi.fn(), error: h.toastError }),
}));

import SettingsClient from './SettingsClient';

const openDialog = async () => {
  render(<SettingsClient />);
  fireEvent.click(
    (await screen.findAllByRole('button', { name: /delete account|حذف الحساب/i }))[0]
  );
};
const confirmBtn = () => {
  const all = screen.getAllByRole('button', { name: /delete account|حذف الحساب/i });
  return all[all.length - 1] as HTMLButtonElement;
};

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset();
  h.toastError.mockReset();
  h.lang.current = 'en';
});
afterEach(cleanup);

describe('SettingsClient close account', () => {
  it('balance > 0 (read from the server): forfeit sentence shown, delete disabled until the box is ticked', async () => {
    h.get.mockResolvedValue({ success: true, data: { walletBalance: 250 } });
    await openDialog();
    expect(h.get).toHaveBeenCalledWith('/auth/me/closure-preview');
    const box = await screen.findByRole('checkbox');
    expect(screen.getByText(/EGP 250 will be forfeited/)).toBeTruthy();
    expect(confirmBtn().disabled).toBe(true);
    fireEvent.click(box);
    expect(confirmBtn().disabled).toBe(false);
  });
  it('balance 0: no checkbox and delete is enabled', async () => {
    h.get.mockResolvedValue({ success: true, data: { walletBalance: 0 } });
    await openDialog();
    await waitFor(() => expect(confirmBtn().disabled).toBe(false));
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
  it.each([
    ['en', 'ACCOUNT_HAS_OPEN_ORDERS', /order in progress/],
    ['ar', 'ACCOUNT_HAS_OPEN_ORDERS', /طلب شغال/],
    ['en', 'ACCOUNT_HAS_OPEN_RETURN', /return or refund in progress/],
    ['ar', 'ERASURE_INCOMPLETE', /معرفناش نكمّل/],
  ] as const)(
    '%s: error code %s is shown as locale text, never the joined string',
    async (lang, code, re) => {
      h.lang.current = lang;
      h.get.mockResolvedValue({ success: true, data: { walletBalance: 0 } });
      h.post.mockResolvedValue({ success: false, error: { code, message: 'en | ar joined' } });
      await openDialog();
      await waitFor(() => expect(confirmBtn().disabled).toBe(false));
      fireEvent.click(confirmBtn());
      await waitFor(() => expect(h.toastError).toHaveBeenCalled());
      const text = h.toastError.mock.calls[0][1] as string;
      expect(text).toMatch(re);
      expect(text).not.toContain('|');
    }
  );
});
