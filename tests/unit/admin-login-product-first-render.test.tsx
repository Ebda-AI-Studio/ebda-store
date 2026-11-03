// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { render, screen, waitFor } from '@testing-library/react';
import ar from '../../apps/admin/src/i18n/messages/ar.json';
import en from '../../apps/admin/src/i18n/messages/en.json';

const state = { locale: 'ar' as 'ar' | 'en' };
function lookup(ns: string, key: string): string {
  const root = (state.locale === 'ar' ? ar : en) as unknown as Record<string, unknown>;
  let cur: unknown = root;
  for (const p of [...ns.split('.'), ...key.split('.')])
    cur = (cur as Record<string, unknown>)?.[p];
  return typeof cur === 'string' ? cur : `${ns}.${key}`;
}
vi.mock('@/i18n/useT', () => ({ useT: (ns: string) => (k: string) => lookup(ns, k) }));
vi.mock('next-intl', () => ({
  useLocale: () => state.locale,
  useTranslations: (ns: string) => (k: string) => lookup(ns, k),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: (p: { children: React.ReactNode }) => <a>{p.children}</a>,
}));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@ebda/ui', () => ({
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
  Input: (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} />,
}));
vi.mock('../../apps/admin/src/lib/auth', () => ({
  useAuth: () => ({
    isAuthenticated: false,
    isLoading: false,
    login: vi.fn(),
    completeMfaLogin: vi.fn(),
    loginWithPasskey: vi.fn(),
  }),
  postLoginDestination: () => '/',
  goAfterSignIn: vi.fn(),
}));
vi.mock('../../apps/admin/src/lib/passkeys', () => ({
  isPasskeyCancel: () => false,
  passkeyAutofillSupported: async () => false,
  passkeysSupported: () => false,
}));
vi.mock('@/components/AdminLanguageSwitcher', () => ({ default: () => null }));
vi.mock('@/components/DocumentTitle', () => ({ DocumentTitle: () => null }));
vi.mock('../../apps/admin/src/app/login/_components/NileNight', () => ({ NileNight: () => null }));

import LoginPage from '../../apps/admin/src/app/login/page';

vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});

const STORE_NAMES = ['ابدأ ستور', 'Ebda Store'];

describe('/login?product=chat never shows the Store first', () => {
  for (const locale of ['ar', 'en'] as const) {
    it(`${locale}: the first render (before the query is read) names no product`, () => {
      state.locale = locale;
      window.history.pushState({}, '', '/login?product=chat');
      const html = renderToString(<LoginPage />);
      for (const n of STORE_NAMES) expect(html).not.toContain(n);
      expect(html).not.toContain('ابدأ شات');
      expect(html).not.toContain('Ebda Chat');
    });

    it(`${locale}: once resolved it shows Chat, and still never the Store`, async () => {
      state.locale = locale;
      window.history.pushState({}, '', '/login?product=chat');
      const { container } = render(<LoginPage />);
      await waitFor(() =>
        expect(container.textContent).toContain(locale === 'ar' ? 'ابدأ شات' : 'Ebda Chat')
      );
      for (const n of STORE_NAMES) expect(container.textContent).not.toContain(n);
    });
  }

  it('no product (or an unknown one) resolves to the Store', async () => {
    state.locale = 'en';
    window.history.pushState({}, '', '/login?product=crm');
    const { container } = render(<LoginPage />);
    await waitFor(() => expect(container.textContent).toContain('Ebda Store'));
    void screen;
  });
});
