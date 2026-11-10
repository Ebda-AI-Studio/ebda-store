// @vitest-environment jsdom
/**
 * STOP-2 re-audit M3 (a11y): the prominent search form follows the logo link in the DOM, before the
 * nav and the actions, so Tab goes logo, search, nav, actions (grid placement is explicit, so the
 * visual order does not depend on the DOM order).
 *
 * Behaviour, not source text: the REAL Header is rendered and the order of the rendered elements is
 * read with `compareDocumentPosition`. (Split out of souq-stop2-a11y.test.tsx, whose other tests
 * need none of these context mocks.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({
    store: { id: 'store-s', name: 'Souq Demo', template: 'souq', look: null, theme: {} },
    isPlatform: false,
    isLoading: false,
  }),
  useStoreUrl: () => (p: string) => p,
  useStoreTheme: () => ({}),
  useStoreTemplate: () => 'souq',
  useIsPlatform: () => false,
  useStoreBranding: () => ({ name: 'Souq Demo' }),
  useStoreContact: () => ({}),
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLanguage: () => ({
    language: 'en',
    direction: 'ltr',
    isRtl: false,
    setLanguage: () => {},
    t: (en: string) => en,
  }),
}));
vi.mock('../../apps/web/src/contexts/CartContext', () => ({
  useCart: () => ({ items: [], bundles: [], itemCount: 0, total: 0 }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { default: Header } = await import('../../apps/web/src/templates/base/Header');

afterEach(cleanup);

const FOLLOWS = Node.DOCUMENT_POSITION_FOLLOWING;

describe('M3: the prominent search form follows the logo link in the DOM, before the nav and the actions', () => {
  it('logo < search < nav < actions', () => {
    const { container } = render(
      <Header
        branding={{ name: 'Souq Demo', nameAr: 'سوق', logo: null }}
        navigation={[{ href: '/shop', label: 'Shop', labelAr: 'تسوّق' }]}
        cartItemCount={2}
        searchPlacement="prominent"
      />
    );
    const q = (sel: string) => {
      const el = container.querySelector(sel);
      expect(el, `${sel} not rendered`).not.toBeNull();
      return el as Element;
    };
    const logo = q('a [data-zone="storeName"]').closest('a') as Element;
    const form = q('form[data-zone="souq-search"]');
    const nav = q('nav[aria-label="Main"]');
    const actions = q('a[aria-label^="Cart"]');
    expect(logo.compareDocumentPosition(form) & FOLLOWS).toBeTruthy();
    expect(form.compareDocumentPosition(nav) & FOLLOWS).toBeTruthy();
    expect(form.compareDocumentPosition(actions) & FOLLOWS).toBeTruthy();
  });
});
