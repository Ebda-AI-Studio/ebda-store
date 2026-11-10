// @vitest-environment jsdom
/**
 * a11y re-audit P1-N3 + P2-N6: the empty cart's only action ("ابدأ التسوق ←" / "Start Shopping →")
 * measured 73-109 x 25 and drew its direction as a literal glyph. Every skin's EmptyState CTA is a
 * 44px target, its arrow (if any) is the one mirroring icon (rtl:-scale-x-100), never ← or →.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { smallTargets } from '../helpers/target-size';

vi.mock('next/link', () => ({
  default: ({ children, href, ...p }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));

vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLanguage: () => ({ language: 'ar', isRtl: true, t: (_e: string, a: string) => a }),
}));

vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({
    store: { id: 'store-a', name: 'Shop', theme: {}, look: null, settings: {} },
    layout: null,
  }),
  useStoreUrl: () => (p: string) => p,
  useStoreTheme: () => ({}),
}));

// The cart page, rendered for real: a non-empty cart so the "Continue shopping" row is on screen.
vi.mock('../../apps/web/src/contexts/FeatureContext', () => ({
  useFeatures: () => ({ isEnabled: () => false }),
}));
vi.mock('../../apps/web/src/contexts/CartContext', () => ({
  useCart: () => ({
    items: [{ id: 'line', productId: 'p1', name: 'Ring', price: 10000, quantity: 1 }],
    bundles: [],
    itemCount: 1,
    total: 10000,
    isReady: true,
  }),
}));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: { get: () => Promise.resolve({ success: true, data: {} }) },
}));
vi.mock('../../apps/web/src/hooks/useTemplateComponents', () => ({
  useTemplateComponents: () => ({ components: null }),
}));
vi.mock('../../apps/web/src/hooks/useLastListing', () => ({ useLastListing: () => '/products' }));
vi.mock('../../apps/web/src/components', () => ({
  ShopChrome: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../apps/web/src/components/CartRecommendations', () => ({
  CartRecommendations: () => null,
}));
vi.mock('@ebda/ui', async original => ({
  ...(await original<Record<string, unknown>>()),
  useToast: () => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }),
}));

const T = '../../apps/web/src/templates';
const SKINS = ['base', 'dahab'];
afterEach(cleanup);

describe.each(SKINS)('%s EmptyState CTA', skin => {
  it.each([true, false])('rtl=%s: 44px, no glyph arrow', async isRtl => {
    const { default: EmptyState } = await import(`${T}/${skin}/EmptyState.tsx`);
    const { container } = render(
      <EmptyState
        title="Your cart is empty"
        titleAr="سلة التسوق فاضية"
        ctaLabel="Start shopping"
        ctaLabelAr="ابدأ التسوق"
        ctaHref="/products"
        isRtl={isRtl}
      />
    );
    expect(smallTargets(container, 44)).toEqual([]);
    expect(container.textContent).not.toMatch(/[←→]/);
  });
});

describe('the cart page "Continue shopping" link is a 44px target (P1-N3)', () => {
  it('measured 97-151 x 20; it is now a 44px inline-flex row', async () => {
    const { default: CartClient } = await import('../../apps/web/src/app/cart/CartClient');
    const { container } = render(<CartClient />);
    // The mocked `t` returns the Arabic string, which is what the shopper reads here.
    const link = [...container.querySelectorAll('a')].find(a =>
      a.textContent?.includes(
        '\u0645\u062a\u0627\u0628\u0639\u0629 \u0627\u0644\u062a\u0633\u0648\u0642'
      )
    );
    expect(link, 'the Continue shopping link is not on the cart page').toBeTruthy();
    expect(smallTargets(link!.parentElement!, 44)).toEqual([]);
  });
});
