// @vitest-environment jsdom
/**
 * #1557 — BundleCard: the Add-to-Cart <button> must not be nested inside the
 *         card's <a>.
 * #1556 — BundleDetailClient: an SSR'd bundle is not re-fetched on mount, and a
 *         transient failure never replaces a rendered bundle with "not found".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, act, cleanup } from '@testing-library/react';

const params = { slug: 'ramadan-box' };
vi.mock('next/navigation', () => ({ useParams: () => params }));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({
    href,
    children,
    className,
  }: React.PropsWithChildren<{ href: string; className?: string }>) =>
    React.createElement('a', { href, className }, children),
}));
vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ alt }: { alt?: string }) => React.createElement('img', { alt }),
}));
const getPublicBundle = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { getPublicBundle: (...a: unknown[]) => getPublicBundle(...a) },
}));
vi.mock('../../hooks/useLocalePrice', () => ({
  useLocalePrice: () => (n: number) => `${n / 1000} EGP`,
}));
vi.mock('../../hooks/useNumerals', () => ({
  useNumerals: () => ({ localize: (s: unknown) => String(s) }),
}));
let addBundleImpl: () => Promise<boolean> = async () => true;
vi.mock('../../contexts/CartContext', () => ({
  useCart: () => ({ addBundle: () => addBundleImpl() }),
}));
vi.mock('../../contexts/StoreContext', () => ({
  useStore: () => ({ store: { id: 'store-1' } }),
  useStoreUrl: () => (p: string) => p,
}));
vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', t: (en: string) => en }),
  translations: {},
}));
vi.mock('../../components', () => ({
  ShopChrome: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
}));
vi.mock('../../components/MarketingPixels', () => ({ trackAddToCart: vi.fn() }));
vi.mock('../../components/BundleLine', () => ({ BundlePlaceholderIcon: () => null }));

import { BundleCard } from './BundleCard';
import BundleDetailClient from './[slug]/BundleDetailClient';

const BUNDLE = {
  id: 'b1',
  slug: 'ramadan-box',
  name: 'Ramadan Box',
  nameAr: null,
  image: null,
  price: 12000,
  componentSum: 15000,
  description: 'A box',
  descriptionAr: null,
  isPurchasable: true,
  componentNames: [{ name: 'Dates', nameAr: null }],
};

afterEach(() => cleanup());

describe('BundleCard (#1557)', () => {
  it('renders no interactive control inside the card link', () => {
    const { container } = render(<BundleCard bundle={BUNDLE as never} />);
    for (const a of container.querySelectorAll('a')) {
      expect(a.querySelector('button, a, input')).toBeNull();
    }
    expect(container.querySelector('button')).not.toBeNull();
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/bundles/ramadan-box');
  });
});

describe('BundleCard (#2198) — the busy button still absorbs taps', () => {
  afterEach(() => {
    addBundleImpl = async () => true;
  });

  it('while adding, the element stacked over the stretched link is never pointer-events-none', async () => {
    // Hold the add in flight so the card renders its loading state.
    addBundleImpl = () => new Promise<boolean>(() => {});
    const { container } = render(<BundleCard bundle={BUNDLE as never} />);
    const button = container.querySelector('button')!;
    await act(async () => {
      button.click();
    });
    expect(button.disabled).toBe(true);
    // The disabled Button is `disabled:pointer-events-none`, so it cannot be
    // the layer that sits above the link's `after:inset-0` overlay: the
    // positioned z-10 layer must be an ancestor that stays hit-testable.
    expect(button.className).toContain('disabled:pointer-events-none');
    expect(button.className).not.toMatch(/\bz-10\b/);
    const layer = button.closest('.z-10');
    expect(layer, 'no z-10 layer above the stretched link').not.toBeNull();
    expect(layer).not.toBe(button);
    expect(layer!.className).toMatch(/\brelative\b/);
    expect(layer!.className).not.toContain('pointer-events-none');
    expect(layer!.closest('a')).toBeNull();
  });
});

describe('BundleDetailClient (#1556)', () => {
  beforeEach(() => {
    getPublicBundle.mockReset();
    params.slug = 'ramadan-box';
  });

  it('does not re-fetch a bundle the server already rendered for this slug', async () => {
    const view = render(<BundleDetailClient initialBundle={BUNDLE as never} />);
    await act(async () => {});
    expect(getPublicBundle).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('Ramadan Box');
  });

  it('a failed fetch for a DIFFERENT slug never shows the previous bundle', async () => {
    getPublicBundle.mockRejectedValue(new Error('network'));
    const view = render(
      <BundleDetailClient initialBundle={{ ...BUNDLE, slug: 'other' } as never} />
    );
    await act(async () => {});
    expect(getPublicBundle).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toContain('Bundle not found');
  });

  it('only an explicit unsuccessful answer means not found', async () => {
    getPublicBundle.mockResolvedValue({ success: false });
    const view = render(<BundleDetailClient initialBundle={null} />);
    await act(async () => {});
    expect(view.container.textContent).toContain('Bundle not found');
  });
});
