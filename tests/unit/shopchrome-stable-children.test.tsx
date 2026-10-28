// @vitest-environment jsdom
/**
 * SEO-1 (P14): ShopChrome renders a placeholder until the template chunk loads. The page body (`children`) must
 * keep the SAME DOM node across that switch. It used to be unmounted and rebuilt (a different wrapper tree), which
 * replaced the product <img> after hydration: a second, late LCP candidate (6.7-7.8 s on slow 4G) and a layout shift.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';

const h = vi.hoisted(() => ({
  state: { loading: true } as { loading: boolean },
  listeners: new Set<() => void>(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('@web/contexts/StoreContext', () => ({
  useStore: () => ({
    store: {
      theme: {},
      settings: {},
      announcementBar: { enabled: true, text: 'sale' },
      enabledFeatures: [],
    },
    layout: undefined,
    draftSettings: undefined,
  }),
  useStoreBranding: () => ({}),
  useStoreContact: () => ({ socialLinks: {} }),
  useStoreUrl: () => (p: string) => p,
}));
vi.mock('@web/contexts/LanguageContext', () => ({ useLanguage: () => ({ language: 'ar' }) }));
vi.mock('@web/contexts/CartContext', () => ({ useCart: () => ({ itemCount: 0 }) }));
vi.mock('@web/hooks/useTemplateComponents', () => ({
  useTemplateComponents: () => {
    const [, force] = React.useReducer((x: number) => x + 1, 0);
    React.useEffect(() => {
      h.listeners.add(force);
      return () => void h.listeners.delete(force);
    }, []);
    return h.state.loading
      ? { components: null, isLoading: true }
      : {
          isLoading: false,
          components: {
            Header: () => <header data-testid="hdr" />,
            Footer: () => <footer />,
            AnnouncementBar: () => <div data-testid="ann" />,
          },
        };
  },
}));
vi.mock('@web/templates/shared/BottomTabBar', () => ({ BottomTabBar: () => null }));
vi.mock('@web/templates/shared/FloatingWidget', () => ({ FloatingWidget: () => null }));
vi.mock('@web/components/StickyHeaderOffset', () => ({ StickyHeaderOffset: () => null }));
vi.mock('@web/components/commerce/StickyBrowseCartBar', () => ({
  StickyBrowseCartBar: () => null,
}));

import { ShopChrome } from '../../apps/web/src/components/ShopChrome';

describe('ShopChrome: children survive the template chunk arriving', () => {
  it('keeps the same DOM node (no remount) and reserves the header row while loading', () => {
    h.state.loading = true;
    const { getByTestId, queryByTestId } = render(
      <ShopChrome>
        <img data-testid="hero" alt="" />
      </ShopChrome>
    );
    const before = getByTestId('hero');
    expect(queryByTestId('hdr')).toBeNull();
    expect(document.querySelector('[data-zone="header"]')).not.toBeNull();
    act(() => {
      h.state.loading = false;
      h.listeners.forEach(f => f());
    });
    expect(queryByTestId('hdr')).not.toBeNull();
    expect(getByTestId('hero')).toBe(before);
  });
});
