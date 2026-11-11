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
  lang: undefined as string | undefined,
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
      language: ctx.lang ?? 'en',
      direction: ctx.lang === 'ar' ? 'rtl' : 'ltr',
      isRtl: ctx.lang === 'ar',
      setLanguage: () => {},
      t: (en: string, ar?: string) => (ctx.lang === 'ar' ? (ar ?? en) : en),
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

async function renderPdp(
  theme: Record<string, unknown>,
  layout?: Record<string, unknown>,
  images: { id: string; url: string; alt: string }[] = [{ id: 'i1', url: '/a.webp', alt: 'a' }],
  overrides: Record<string, unknown> = {}
) {
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
    images,
    variants: [],
    options: [],
    categories: [],
    ...overrides,
  };
  const { container } = render(
    <ProductDetailClient initialProduct={p as never} layout={layout as never} />
  );
  const frame = container.querySelector('.snap-x')!.parentElement as HTMLElement;
  const crumb = container.querySelector('[data-zone="products"] > nav') as HTMLElement;
  return { frame, crumb, container };
}

describe('airy (image-led) PDP gallery', () => {
  it('density airy: edge to edge at 4:5 below sm, capped from sm; phone breadcrumb hidden (all stores, C-04)', async () => {
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
    // The phone breadcrumb is hidden on EVERY store since main's C-04 (shared Breadcrumbs, below md).
    expect(crumb.className.split(' ')).toEqual(expect.arrayContaining(['hidden', 'md:block']));
  });
  it('other densities and no density: the capped gallery, unchanged; breadcrumb as on every store', async () => {
    for (const theme of [{}, { density: 'regular' }, { density: 'compact' }]) {
      const { frame, crumb } = await renderPdp(theme);
      cleanup();
      expect(frame.hasAttribute('data-gallery')).toBe(false);
      expect(frame.className).toBe(
        'relative aspect-[3/4] mx-auto max-w-[280px] sm:max-w-[400px] lg:max-w-[600px] overflow-hidden rounded-[var(--radius)] bg-gradient-to-br from-primary/5 to-primary/10'
      );
      expect(crumb.className.split(' ')).toEqual(expect.arrayContaining(['hidden', 'md:block']));
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

// a11y P1-7 / AT-2 / R-08 (W4): the gallery scroller had no role or name and no buttons, so photo 2
// was reachable by touch or a mouse wheel only.
describe('PDP gallery is a named region with prev/next buttons', () => {
  const two = [
    { id: 'i1', url: '/a.webp', alt: 'a' },
    { id: 'i2', url: '/b.webp', alt: 'b' },
  ];
  it('names the track, and the next button moves to photo 2 (announced)', async () => {
    const { container } = await renderPdp({}, undefined, two);
    const track = container.querySelector('[aria-roledescription="carousel"]') as HTMLElement;
    expect(track.getAttribute('role')).toBe('region');
    expect(track.getAttribute('aria-label')).toMatch(/Linen Abaya|عباية كتان/);
    const next = container.querySelector('button[data-gallery-next]') as HTMLButtonElement;
    const prev = container.querySelector('button[data-gallery-prev]') as HTMLButtonElement;
    expect(next && prev).toBeTruthy();
    expect(prev.disabled).toBe(true);
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(next);
    expect(container.querySelector('[data-gallery-status]')!.textContent).toContain('2');
    expect(next.disabled).toBe(true);
  });
  it('one photo: no buttons', async () => {
    const { container } = await renderPdp({});
    expect(container.querySelector('button[data-gallery-next]')).toBeNull();
  });
});

// Taste re-audit P2-1 (quality bar § 8, Y-05): "متوفر" / "In stock" rendered on every
// in-stock PDP, a status true for almost every item. The stock line shows only when it says
// something: pre-order or out of stock.
describe('PDP stock line only when it is news (P2-1)', () => {
  it('an in-stock product shows no stock line', async () => {
    const { container } = await renderPdp({});
    expect(container.textContent).not.toMatch(/In stock|متوفر(?! )/);
  });
});

// a11y re-audit P2-N5: in Arabic the strip was dir=ltr, so photo 2 came in from the right while
// Next sat on the left (inline end) and ArrowLeft meant next. The strip follows the page
// direction: in Arabic photo 2 lies to the left, where Next and ArrowLeft point.
describe('the gallery reads in the page direction (P2-N5)', () => {
  const two = [
    { id: 'i1', url: '/a.webp', alt: 'a' },
    { id: 'i2', url: '/b.webp', alt: 'b' },
  ];
  it.each([
    ['ar', 'rtl'],
    ['en', 'ltr'],
  ])('%s strip is %s, Next at the inline end', async (l, dir) => {
    ctx.lang = l;
    try {
      const { container } = await renderPdp({}, undefined, two);
      const track = container.querySelector('[aria-roledescription="carousel"]') as HTMLElement;
      expect(track.getAttribute('dir')).toBe(dir);
      expect(container.querySelector('button[data-gallery-next]')!.className).toContain('end-2');
    } finally {
      ctx.lang = undefined;
    }
  });
});

// a11y re-audit P2-N11: on a sold-out PDP the quantity steppers stayed enabled while the buy
// button read Out of stock (disabled): a control that does nothing.
describe('sold-out PDP steppers are disabled (P2-N11)', () => {
  it('both steppers disabled when the product cannot be bought', async () => {
    const { container } = await renderPdp({}, undefined, undefined, {
      inStock: false,
      inventory: 0,
    });
    const steppers = Array.from(container.querySelectorAll('button')).filter(b =>
      /Decrease quantity|Increase quantity/.test(b.getAttribute('aria-label') ?? '')
    ) as HTMLButtonElement[];
    expect(steppers.length).toBe(2);
    for (const b of steppers) expect(b.disabled).toBe(true);
  });
});

// Found by the stop4 rendered probe (rule (d)): on phones the PDP's category link (L-08, the
// breadcrumb's stand-in below md) measured 33-41px wide for a short category name.
describe('the phone category link is 44px in both directions', () => {
  it('min-h-11 and min-w-11', async () => {
    // Rendered DOM, not source text: the phone-only (`md:hidden`) wrapper's link to the category PLP.
    const { container } = await renderPdp({}, undefined, undefined, {
      categories: [{ category: { slug: 'abayas', name: 'Abayas', nameAr: 'عبايات' } }],
    });
    const link = container.querySelector('div.md\\:hidden > a[href="/products?category=abayas"]');
    expect(link, 'phone category link not rendered').not.toBeNull();
    expect(link!.className).toMatch(/\bmin-h-11\b/);
    expect(link!.className).toMatch(/\bmin-w-11\b/);
  });
});
