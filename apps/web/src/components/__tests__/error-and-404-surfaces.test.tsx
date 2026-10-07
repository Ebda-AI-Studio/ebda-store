// @vitest-environment jsdom
/**
 * Platform 404 + route error fallback (#1541, #1542, #1842, #1843).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';

const languageState = { language: 'en' as 'en' | 'ar' };
vi.mock('../../contexts/LanguageContext', async importOriginal => {
  const real = await importOriginal<typeof import('../../contexts/LanguageContext')>();
  return {
    ...real,
    useLanguage: () => ({
      language: languageState.language,
      isRtl: languageState.language === 'ar',
      t: (en: string, ar: string) => (languageState.language === 'ar' ? ar : en),
      setLanguage: () => {},
    }),
  };
});

const storeState = { store: { id: 'store-1', slug: 'demo-store' } };
// Host class is an INDEPENDENT signal (#2223): the unresolved 'demo' sentinel
// occurs on a merchant's custom domain too (a transient resolve failure there
// also leaves the client holding it). Deriving isPlatform from the sentinel
// conflated the two and hid the custom-domain regression.
const hostState = { isPlatform: false };
vi.mock('../../contexts/StoreContext', () => ({
  useStore: () => storeState,
  useStoreUrl: () => (p: string) => p,
  useIsPlatform: () => hostState.isPlatform,
}));

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href }, children),
}));

// The chrome is heavy and irrelevant here: a marker proves whether it rendered.
vi.mock('../ShopChrome', () => ({
  ShopChrome: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'shop-chrome' }, children),
}));
vi.mock('../MinimalChrome', () => ({
  MinimalChrome: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'minimal-chrome' }, children),
}));

import { PlatformNotFound } from '../PlatformNotFound';
import { RouteErrorFallback } from '../RouteErrorFallback';
import ProductsListError from '../../app/products/error';
import CheckoutError from '../../app/checkout/error';
import { STORE_UNAVAILABLE_DIGEST } from '../../lib/store-unavailable';

afterEach(() => {
  cleanup();
  languageState.language = 'en';
  storeState.store = { id: 'store-1', slug: 'demo-store' };
  hostState.isPlatform = false;
  refresh.mockReset();
});

describe('PlatformNotFound', () => {
  // #1542
  it('renders Arabic copy for an Arabic visitor', () => {
    languageState.language = 'ar';
    const { container } = render(<PlatformNotFound />);
    expect(container.textContent).toContain('هذه الصفحة غير موجودة');
    expect(container.textContent).toContain('الانتقال إلى ابدأ');
    expect(container.textContent).not.toContain('This page doesn’t exist');
  });

  it('keeps the English copy for an English visitor', () => {
    const { container } = render(<PlatformNotFound />);
    expect(container.textContent).toContain('This page doesn’t exist');
    expect(container.textContent).toContain('Go to Ebda');
  });

  // #1541 — the colour pairs that failed WCAG AA 4.5:1 are gone.
  it('uses AA-contrast colours for the CTA and eyebrow', () => {
    const { container } = render(<PlatformNotFound />);
    const html = container.innerHTML;
    expect(html).not.toContain('bg-[#FF6E01]');
    expect(html).not.toContain('text-neutral-400');
    expect(html).toContain('bg-[#C04E00]');
    expect(html).toContain('text-neutral-600');
  });
});

describe('RouteErrorFallback — Try Again (#1842)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rapid repeat clicks issue ONE refresh inside the cooldown', () => {
    const reset = vi.fn();
    const { getByRole } = render(
      <RouteErrorFallback error={Object.assign(new Error('x'), {})} reset={reset} />
    );
    const button = getByRole('button');
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2100);
    fireEvent.click(button);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe('segment error boundaries during a transient (#1843)', () => {
  const transient = Object.assign(new Error('busy'), { digest: STORE_UNAVAILABLE_DIGEST });
  const ordinary = Object.assign(new Error('boom'), { digest: 'abc' });

  it('drop the chrome when the store is the unresolved sentinel on a platform host', () => {
    storeState.store = { id: 'demo', slug: 'demo' };
    hostState.isPlatform = true;
    const shop = render(<ProductsListError error={transient} reset={() => {}} />);
    expect(shop.queryByTestId('shop-chrome')).toBeNull();
    expect(shop.container.textContent).toContain('We’re a little busy right now');
    cleanup();
    const minimal = render(<CheckoutError error={transient} reset={() => {}} />);
    expect(minimal.queryByTestId('minimal-chrome')).toBeNull();
  });

  it('keep the chrome when the store resolved (its links are correct)', () => {
    const { queryByTestId } = render(<ProductsListError error={transient} reset={() => {}} />);
    expect(queryByTestId('shop-chrome')).not.toBeNull();
  });

  // #2223 — on a merchant's own domain the chrome's prefix-less links are the
  // merchant's own pages, so the chrome (logo, nav, cart, footer) must stay.
  it('keep the chrome on a CUSTOM domain even with the unresolved sentinel', () => {
    storeState.store = { id: 'demo', slug: 'demo' };
    hostState.isPlatform = false;
    const shop = render(<ProductsListError error={transient} reset={() => {}} />);
    expect(shop.queryByTestId('shop-chrome')).not.toBeNull();
    expect(shop.container.textContent).toContain('We’re a little busy right now');
    // …and the Go Home escape route stays too (#1841).
    expect(shop.getByText('Go Home')).toBeTruthy();
    cleanup();
    const minimal = render(<CheckoutError error={transient} reset={() => {}} />);
    expect(minimal.queryByTestId('minimal-chrome')).not.toBeNull();
  });

  it('keep the chrome for an ordinary render error', () => {
    storeState.store = { id: 'demo', slug: 'demo' };
    const { queryByTestId } = render(<ProductsListError error={ordinary} reset={() => {}} />);
    expect(queryByTestId('shop-chrome')).not.toBeNull();
  });
});
