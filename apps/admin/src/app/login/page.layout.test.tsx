// @vitest-environment jsdom
/**
 * 2026-11-10 (Ahmad): the sign-in page is always the light split layout, and the Nile animation is
 * a side panel from tablet portrait (768px) up. On a phone NileNight is not mounted at all, so the
 * form starts at the top and no canvas animation runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

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
    isLoading: false,
    isAuthenticated: false,
  }),
  postLoginDestination: () => '/',
}));

import LoginPage from './page';
import { NILE_PANEL_MIN_WIDTH } from './_components/NileSidePanel';

function setViewport(width: number, prefersDark = true) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const matches = min
      ? width >= Number(min[1])
      : query.includes('prefers-color-scheme: dark')
        ? prefersDark
        : false;
    return {
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    };
  });
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  // jsdom has no 2D canvas; NileNight bails out when getContext returns null, so a <canvas> in the
  // DOM is exactly "NileNight mounted".
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('dark');
});

describe('admin /login Nile panel', () => {
  it('uses 768px as the phone/tablet line', () => {
    expect(NILE_PANEL_MIN_WIDTH).toBe(768);
  });

  for (const width of [390, 600, 767]) {
    it(`does not mount NileNight at ${width}px (phone): the form is the first thing in <main>`, () => {
      setViewport(width);
      const { container } = render(<LoginPage />);
      expect(container.querySelector('canvas')).toBeNull();
      const main = container.querySelector('main#admin-main-content')!;
      expect(main.firstElementChild?.querySelector('input[type="email"]')).not.toBeNull();
    });
  }

  for (const width of [768, 820, 1024, 1440]) {
    it(`mounts NileNight in a side panel beside the form at ${width}px`, () => {
      setViewport(width);
      const { container } = render(<LoginPage />);
      const main = container.querySelector('main#admin-main-content')!;
      expect(main.className).toContain('md:flex-row');
      const [form, panel] = Array.from(main.children);
      expect(form.querySelector('input[type="email"]')).not.toBeNull();
      expect(panel.getAttribute('data-testid')).toBe('nile-side-panel');
      expect(panel.querySelector('canvas')).not.toBeNull();
    });
  }
});

describe('admin /login colour scheme', () => {
  it('stays light under prefers-color-scheme: dark, even when html.dark was left by the dashboard', () => {
    setViewport(1440, true);
    document.documentElement.classList.add('dark');
    render(<LoginPage />);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
