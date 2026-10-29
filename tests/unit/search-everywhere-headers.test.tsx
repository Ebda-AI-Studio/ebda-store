// @vitest-environment jsdom
/**
 * Search-as-you-type reaches every storefront header (plan 2026-10-26-search-as-you-type, Ruling
 * SEARCH-EVERYWHERE-1): qamar, souq, jasmine, lamma (all wrap the base header) and dahab (own
 * header) turn their search input into an ARIA combobox after ONE typed character, in Arabic.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

const ctx = vi.hoisted(() => ({
  store: { id: 'store-s', name: 'Demo', template: 'souq', look: null, theme: {} } as Record<
    string,
    unknown
  >,
  suggest: undefined as unknown,
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...p }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (p: { alt?: string; src: string }) => <img alt={p.alt ?? ''} src={p.src} />,
}));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: ctx.store, isPlatform: false, isLoading: false }),
  useStoreUrl: () => (p: string) => p,
  useStoreTheme: () => ctx.store.theme,
  useStoreTemplate: () => ctx.store.template,
  useIsPlatform: () => false,
  useStoreBranding: () => ({ name: ctx.store.name }),
  useStoreContact: () => ({}),
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    useLanguage: () => ({
      language: 'ar',
      direction: 'rtl',
      isRtl: true,
      setLanguage: () => {},
      t: (_en: string, ar: string) => ar,
    }),
  };
});
vi.mock('../../apps/web/src/contexts/CartContext', () => ({
  useCart: () => ({ items: [], bundles: [], itemCount: 0, total: 0 }),
}));
vi.mock('../../apps/web/src/hooks/useLocalePrice', () => ({ useLocalePrice: () => String }));
vi.mock('../../apps/web/src/lib/api', () => ({
  api: {
    searchSuggest: vi.fn(async () => ({
      success: true,
      data: {
        suggestions: [
          { id: 'p1', name: 'Bag', nameAr: 'شنطة', slug: 'bag', price: 10, image: null },
        ],
      },
    })),
  },
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const branding = { name: 'Demo', nameAr: 'تجربة', logo: null };
const nav = [{ href: '/products', label: 'Products', labelAr: 'المنتجات' }];

const headers = {
  qamar: () => import('../../apps/web/src/templates/qamar/Header'),
  souq: () => import('../../apps/web/src/templates/souq/Header'),
  jasmine: () => import('../../apps/web/src/templates/jasmine/Header'),
  lamma: () => import('../../apps/web/src/templates/lamma/Header'),
  dahab: () => import('../../apps/web/src/templates/dahab/Header'),
} as const;

afterEach(cleanup);

describe.each(Object.keys(headers) as (keyof typeof headers)[])('%s header search', name => {
  it('becomes an ARIA combobox with a listbox after one Arabic character', async () => {
    vi.useFakeTimers();
    ctx.store = { ...ctx.store, template: name };
    const { default: Header } = await headers[name]();
    const { container } = render(<Header branding={branding} navigation={nav} />);
    // the first search input in the DOM is the one the visitor types in (hidden-until-open
    // fields still mount, so no click is needed to find it)
    const inputs = [...container.querySelectorAll<HTMLInputElement>('form input')].filter(
      i => i.type === 'search' || i.type === 'text'
    );
    expect(inputs.length).toBeGreaterThan(0);
    const input = inputs[0];
    await act(async () => {
      fireEvent.change(input, { target: { value: 'ش' } });
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const listboxId = input.getAttribute('aria-controls');
    expect(listboxId).toBeTruthy();
    expect(container.ownerDocument.getElementById(listboxId!)?.getAttribute('role')).toBe(
      'listbox'
    );
    vi.useRealTimers();
  });
});
