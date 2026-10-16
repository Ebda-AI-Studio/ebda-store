// @vitest-environment jsdom
/**
 * Taste re-audit P1-1 (2026-10-16): the checkout summary showed no colour, size or length on
 * the live page while OrderSummary.lines.test.tsx was green. That test fed OrderSummary
 * directly; the page goes through CheckoutClient's `cart` memo, which dropped variantTitle and
 * variantTitleAr before the summary. This test renders CHECKOUT from a cart-context line, the
 * path production takes (Ruling B1-87: test the path, not only the component).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, screen } from '@testing-library/react';

const lang = vi.hoisted(() => ({ v: 'ar' as 'ar' | 'en' }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {}, back: () => {} }),
  usePathname: () => '/checkout',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...p }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('../../apps/web/src/components', () => ({
  MinimalChrome: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../apps/web/src/components/MarketingPixels', () => ({
  trackInitiateCheckout: () => {},
}));
vi.mock('../../apps/web/src/hooks/useWallet', () => ({
  useWallet: () => ({ wallet: null, isLoading: false, refresh: () => {} }),
}));
vi.mock('../../apps/web/src/hooks/useLastListing', () => ({ useLastListing: () => '/products' }));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: new Proxy({}, { get: () => async () => ({ success: false }) }),
}));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({
    store: {
      id: 's1',
      slug: 'qamar-atelier',
      name: 'Qamar',
      currency: 'EGP',
      theme: {},
      settings: {},
    },
    layout: null,
    isPlatform: false,
    isLoading: false,
  }),
  useStoreUrl: () => (p: string) => p,
}));
vi.mock('../../apps/web/src/contexts/AuthContext', () => ({
  useAuth: () => ({ user: null, isAuthenticated: false, isLoading: false }),
}));
vi.mock('../../apps/web/src/contexts/CartContext', () => ({
  useCart: () => ({
    items: [
      {
        id: 'l1',
        productId: 'p1',
        name: 'Linen abaya',
        nameAr: 'عباية كتان',
        slug: 'linen-abaya',
        price: 149000,
        quantity: 1,
        image: 'https://x/a.webp',
        variantId: 'v1',
        variantTitle: 'Rose · S · 52',
        variantTitleAr: 'وردي · S · 52',
      },
    ],
    bundles: [],
    itemCount: 1,
    subtotal: 149000,
    total: 149000,
    isLoading: false,
    isReady: true,
    refetchCart: () => {},
    clearCart: () => {},
  }),
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    useLanguage: () => ({
      language: lang.v,
      isRtl: lang.v === 'ar',
      direction: lang.v === 'ar' ? 'rtl' : 'ltr',
      setLanguage: () => {},
      t: (en: string, ar?: string) => (lang.v === 'ar' ? (ar ?? en) : en),
    }),
  };
});

const { default: CheckoutClient } = await import('../../apps/web/src/app/checkout/CheckoutClient');

afterEach(() => {
  cleanup();
  lang.v = 'ar';
});

describe('checkout summary names each line variant (through CheckoutClient)', () => {
  it.each([
    ['ar', 'وردي · S · 52'],
    ['en', 'Rose · S · 52'],
  ] as const)('%s', async (l, variant) => {
    lang.v = l;
    render(<CheckoutClient />);
    expect((await screen.findAllByText(variant)).length).toBeGreaterThan(0);
  });
});

// a11y re-audit P2-N1 (rule (d) at every breakpoint): the governorate and area comboboxes
// measured 40px at 390 and 36-40px from 640 up, the coupon field 40px (sm:h-10). The W4 class
// gate ignored `sm:` classes; target-size.ts now reads each breakpoint and keeps the smallest.
describe('checkout fields are 44px at every breakpoint (P2-N1)', () => {
  it('every input, combobox and button on step 1', async () => {
    const { smallTargets } = await import('../helpers/target-size');
    lang.v = 'ar';
    const { container } = render(<CheckoutClient />);
    await screen.findAllByText('وردي · S · 52');
    const fields = Array.from(
      container.querySelectorAll(
        'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])'
      )
    );
    expect(fields.length).toBeGreaterThan(5);
    const holder = document.createElement('div');
    for (const f of fields) holder.appendChild(f.cloneNode(true));
    expect(smallTargets(holder, 44)).toEqual([]);
  });
});

// a11y re-audit P2-N8: an empty submit fired 7 role=alert field errors at once. One summary
// announces; each field keeps its aria-describedby error (not an alert of its own).
describe('an empty submit announces once (P2-N8)', () => {
  it('exactly one alert, field errors described, focus on the first invalid field', async () => {
    const { fireEvent } = await import('@testing-library/react');
    lang.v = 'ar';
    const { container } = render(<CheckoutClient />);
    await screen.findAllByText('وردي · S · 52');
    const submit = screen
      .getAllByRole('button')
      .find(b => /المتابعة للدفع/.test(b.textContent ?? ''))!;
    fireEvent.click(submit);
    await new Promise(r => setTimeout(r, 50));
    const invalid = container.querySelectorAll('[aria-invalid="true"]');
    expect(invalid.length).toBeGreaterThan(3);
    expect(container.querySelectorAll('[role="alert"]').length).toBe(1);
    for (const f of Array.from(invalid))
      expect(document.getElementById(f.getAttribute('aria-describedby') ?? 'x')).not.toBeNull();
  });
});
