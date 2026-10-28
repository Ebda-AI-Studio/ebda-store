// @vitest-environment jsdom
/**
 * #2159 — the admin password form must be usable while AuthProvider's mount
 * check is still loading. That check can wait out a throttled refresh bucket
 * for ~21s, and a full-screen spinner made the login page unreachable for all
 * of it — on the one page a locked-out admin needs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const auth = vi.hoisted(() => ({ isLoading: true, isAuthenticated: false }));

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({
    login: vi.fn(),
    completeMfaLogin: vi.fn(),
    isLoading: auth.isLoading,
    isAuthenticated: auth.isAuthenticated,
  }),
  postLoginDestination: () => '/',
}));

import LoginPage from './page';

beforeEach(() => {
  // Node's own experimental localStorage global can shadow jsdom's.
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('admin /login while the session check is still running (#2159)', () => {
  it('renders the password form, not a blocking spinner', () => {
    const { container } = render(<LoginPage />);
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.querySelector('input[type="email"]')).not.toBeNull();
    expect(screen.queryAllByRole('button').length).toBeGreaterThan(0);
  });
});

describe('admin /login accessibility (audit UI-4, UI-5)', () => {
  it('has a main landmark that is the skip link target, one h1 (the page title) and an underlined signup link', () => {
    const { container } = render(<LoginPage />);
    const main = container.querySelector('main#admin-main-content');
    expect(main).not.toBeNull();
    expect(main?.getAttribute('tabindex')).toBe('-1');
    const h1s = container.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe('title');
    const signup = container.querySelector('a[href="/signup"]');
    expect(signup?.className).toContain('underline');
    expect(signup?.className).not.toContain('hover:underline');
  });
});
