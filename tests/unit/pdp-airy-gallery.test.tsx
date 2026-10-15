// @vitest-environment jsdom
/**
 * Decision (b), L-03 (W2a): an image-led look (`density: 'airy'`) shows the PDP gallery edge to
 * edge at 4:5 below `sm`, hides the phone breadcrumb so title and price stay in the 390 fold, and
 * keeps the merchant's own gallery aspect when one is set. Every other store renders the capped
 * 280px 3:4 gallery and the breadcrumb exactly as before. Harness: pdp-sticky-parity.test.tsx.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { STORES } from '../fixtures/builder/homepage-data';

const ctx = vi.hoisted(() => ({
  addItem: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  store: null as unknown as Record<string, unknown>,
  ioCallback: (() => {}) as (e: unknown[]) => void,
  all: [] as Array<(e: unknown[]) => void>,
}));

vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: ctx.store, layout: null, isPlatform: false, isLoading: false }),
  useStoreUrl: () => (p: string) => p,
  useStoreTheme: () => ctx.store.theme,
  useStoreTemplate: () => ctx.store.template,
  useIsPlatform: () => false,
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    useLanguage: () => ({
      language: 'en',
      direction: 'ltr',
      isRtl: false,
      setLanguage: () => {},
      t: (en: string) => en,
    }),
  };
});
vi.mock('../../apps/web/src/contexts/CartContext', () => ({
  useCart: () => ({ items: [], itemCount: 0, total: 0, addItem: ctx.addItem }),
}));
vi.mock('../../apps/web/src/contexts/FeatureContext', () => ({
  useFeatures: () => ({ isEnabled: () => false }),
}));
vi.mock('../../apps/web/src/hooks/useTemplateComponents', () => ({
  useTemplateComponents: () => ({ isLoading: false }),
}));
vi.mock('../../apps/web/src/hooks/useNumerals', () => ({
  useNumerals: () => ({ localize: (v: string | number) => String(v), numerals: 'latn' }),
  useStoreNumerals: () => 'latn',
}));
vi.mock('../../apps/web/src/hooks/useLocalePrice', () => ({
  useLocalePrice: () => (n: number) => `EGP ${n / 100}`,
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ slug: 'linen-abaya' }),
  usePathname: () => '/products/linen-abaya',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@ebda/ui', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, useToast: () => ({ success: vi.fn(), error: vi.fn() }) };
});
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('../../apps/web/src/components', () => ({
  ShopChrome: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SectionErrorBoundary: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../apps/web/src/components/MarketingPixels', () => ({
  trackViewContent: () => {},
  trackAddToCart: () => {},
}));
vi.mock('../../apps/web/src/components/PostHogProvider', () => ({ captureEvent: () => {} }));
vi.mock('../../apps/web/src/components/ProductModel3d', () => ({
  Model3dToggle: () => null,
  ProductModel3dPanel: () => null,
}));
vi.mock('../../apps/web/src/components/commerce/DeliveryChip', () => ({
  DeliveryChip: () => null,
}));
vi.mock('../../apps/web/src/templates/shared/ShareProductRow', () => ({
  ShareProductRow: () => null,
}));
vi.mock('../../apps/web/src/templates/shared/ProductCarousel', () => ({
  ProductCarousel: () => null,
}));
vi.mock('@/lib/api', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    api: {
      beaconProductView: () => {},
      get: vi.fn(async () => ({ data: [] })),
      getProducts: vi.fn(async () => ({ data: [] })),
    },
  };
});

class IO {
  constructor(cb: (e: unknown[]) => void) {
    ctx.ioCallback = cb;
    ctx.all.push(cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  ctx.addItem = vi.fn(async () => true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPdp(theme: Record<string, unknown>, layout?: Record<string, unknown>) {
  vi.stubGlobal('IntersectionObserver', IO);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  const { default: ProductDetailClient } =
    await import('../../apps/web/src/app/products/[slug]/ProductDetailClient');
  ctx.store = { ...STORES.A, template: 'qamar', theme: { ...(STORES.A as any).theme, ...theme } };
  const p = {
    id: 'p1',
    slug: 'linen-abaya',
    name: 'Linen Abaya',
    nameAr: 'عباية كتان',
    price: 149000,
    inStock: true,
    inventory: 5,
    images: [{ id: 'i1', url: '/a.webp', alt: 'a' }],
    variants: [],
    options: [],
    categories: [],
  };
  const { container } = render(
    <ProductDetailClient initialProduct={p as never} layout={layout as never} />
  );
  const frame = container.querySelector('.snap-x')!.parentElement as HTMLElement;
  const crumb = container.querySelector('[data-zone="products"] > nav') as HTMLElement;
  return { frame, crumb };
}

describe('airy (image-led) PDP gallery', () => {
  it('density airy: edge to edge at 4:5 below sm, capped from sm; phone breadcrumb hidden', async () => {
    const { frame, crumb } = await renderPdp({ density: 'airy' });
    expect(frame.getAttribute('data-gallery')).toBe('airy');
    for (const c of [
      'aspect-[4/5]',
      'sm:aspect-[3/4]',
      '-mx-4',
      'w-[calc(100%+2rem)]',
      'rounded-none',
    ])
      expect(frame.className.split(' '), c).toContain(c);
    for (const c of ['sm:max-w-[400px]', 'lg:max-w-[600px]', 'sm:rounded-[var(--radius)]'])
      expect(frame.className.split(' '), c).toContain(c);
    expect(frame.className).not.toContain('max-w-[280px]');
    expect(crumb.className.split(' ')).toEqual(expect.arrayContaining(['hidden', 'sm:flex']));
  });
  it('other densities and no density: the capped gallery and the breadcrumb, unchanged', async () => {
    for (const theme of [{}, { density: 'regular' }, { density: 'compact' }]) {
      const { frame, crumb } = await renderPdp(theme);
      cleanup();
      expect(frame.hasAttribute('data-gallery')).toBe(false);
      expect(frame.className).toBe(
        'relative aspect-[3/4] mx-auto max-w-[280px] sm:max-w-[400px] lg:max-w-[600px] overflow-hidden rounded-[var(--radius)] bg-gradient-to-br from-primary/5 to-primary/10'
      );
      expect(crumb.className.split(' ')).toContain('flex');
      expect(crumb.className).not.toContain('hidden');
    }
  });
  it('a merchant gallery aspect wins over the airy 4:5', async () => {
    const { frame } = await renderPdp(
      { density: 'airy' },
      { productsPage: { pdpImageAspect: 'square' } }
    );
    expect(frame.className.split(' ')).toContain('aspect-square');
    expect(frame.className).not.toContain('aspect-[4/5]');
    expect(frame.className.split(' ')).toContain('-mx-4');
  });
  it('the airy looks are pinned: a new one needs the design.md exception review (Ruling B1-50)', async () => {
    const { LOOKS } = await import('@ebda/shared');
    expect(
      LOOKS.filter(l => l.tokens.density === 'airy')
        .map(l => l.id)
        .sort()
    ).toEqual(['dahab.worn', 'jasmine.clinic', 'lamma.notebook', 'qamar.atelier', 'souq.showroom']);
  });
  it('design.md documents the exception and its ceilings', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const md = readFileSync(path.resolve(__dirname, '../../design.md'), 'utf8');
    expect(md).toContain("## Exception: image-led looks (`density: 'airy'`");
    expect(md).toContain('≤ 4 columns at 1280');
    expect(md).toContain('**4:5**');
  });
});
