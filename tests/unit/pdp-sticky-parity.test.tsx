// @vitest-environment jsdom
/**
 * Task 6 invariant: on the default PDP the phone sticky bar is NOT a second buy
 * path. Its label and disabled state are the main button's, always (one
 * `addDisabled`, one `addLabel`), including the required-personalisation gate.
 * Also pins the Dahab pinned bar's body flag.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { STORES } from '../fixtures/builder/homepage-data';

const ctx = vi.hoisted(() => ({
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
  useCart: () => ({ items: [], itemCount: 0, total: 0, addItem: vi.fn(async () => {}) }),
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const product = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  slug: 'linen-abaya',
  name: 'Linen Abaya',
  nameAr: 'عباية كتان',
  price: 149000,
  inStock: true,
  inventory: 5,
  images: [],
  variants: [],
  options: [],
  categories: [],
  ...over,
});

async function renderPdp(p: Record<string, unknown>) {
  vi.stubGlobal('IntersectionObserver', IO);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  const { default: ProductDetailClient } =
    await import('../../apps/web/src/app/products/[slug]/ProductDetailClient');
  ctx.store = { ...STORES.A, template: 'minimal' };
  render(<ProductDetailClient initialProduct={p as never} />);
  act(() => ctx.ioCallback([{ isIntersecting: false, boundingClientRect: { top: -10 } }]));
  const sticky = screen.getByTestId('sticky-atc');
  const stickyBtn = sticky.querySelector('button') as HTMLButtonElement;
  // the main button is the other add button: same label text, outside the sticky bar
  const main = screen
    .getAllByRole('button')
    .find(b => !sticky.contains(b) && b.textContent?.trim() === stickyBtn.textContent?.trim());
  return { sticky, stickyBtn, main: main as HTMLButtonElement | undefined };
}

describe('default PDP sticky bar mirrors the main add button', () => {
  it('enabled product: same label, both enabled', async () => {
    const { stickyBtn, main } = await renderPdp(product());
    expect(main).toBeTruthy();
    expect(stickyBtn.textContent).toBe('Add to Cart');
    expect(stickyBtn.disabled).toBe(false);
    expect(main!.disabled).toBe(false);
  });

  it('required personalisation empty: both disabled; typing the note enables both', async () => {
    const { stickyBtn, main } = await renderPdp(
      product({
        personalisation: {
          enabled: true,
          required: true,
          maxLength: 12,
          label: 'Name',
          labelAr: 'الاسم',
        },
      })
    );
    expect(main).toBeTruthy();
    expect(main!.disabled).toBe(true);
    expect(stickyBtn.disabled).toBe(true);
    fireEvent.change(document.querySelector('input[maxlength]') as HTMLInputElement, {
      target: { value: 'Sara' },
    });
    expect(main!.disabled).toBe(false);
    expect(stickyBtn.disabled).toBe(false);
  });

  it('out of stock: same label and both disabled', async () => {
    const { stickyBtn, main } = await renderPdp(product({ inStock: false, inventory: 0 }));
    expect(stickyBtn.textContent).toBe('Out of Stock');
    expect(main).toBeTruthy();
    expect(main!.disabled).toBe(true);
    expect(stickyBtn.disabled).toBe(true);
  });
});

// DahabProductDetail's children create observers too; deliver the entry to all of them.
const fireAll = (entries: unknown[]) => ctx.all.forEach(cb => cb(entries));

describe('Dahab pinned bar body flag', () => {
  it('sets body[data-sticky-atc] only while the buy button is scrolled past, and clears on unmount', async () => {
    vi.stubGlobal('IntersectionObserver', IO);
    const { DahabProductDetail } = await import('../../apps/web/src/templates/dahab/ProductDetail');
    ctx.store = { ...STORES.A, template: 'dahab' };
    const props = {
      images: [],
      name: 'Ring',
      categoryName: null,
      homeHref: '/',
      productsHref: '/products',
      shippingHref: '/shipping',
      returnsHref: '/returns',
      priceText: 'EGP 10',
      compareText: null,
      badges: [],
      variants: [],
      options: [],
      onVariantSelect: () => {},
      onShopperSelect: () => {},
      quantity: 1,
      setQuantity: () => {},
      onAddToCart: () => {},
      isAdding: false,
      addDisabled: false,
      addLabel: 'Add',
    };
    ctx.all.length = 0;
    const { unmount } = render(<DahabProductDetail {...(props as never)} />);
    expect(document.body.dataset.stickyAtc).toBeUndefined();
    act(() => fireAll([{ isIntersecting: false, boundingClientRect: { top: -10 } }]));
    expect(document.body.dataset.stickyAtc).toBe('1');
    act(() => fireAll([{ isIntersecting: true, boundingClientRect: { top: 100 } }]));
    expect(document.body.dataset.stickyAtc).toBeUndefined();
    act(() => fireAll([{ isIntersecting: false, boundingClientRect: { top: -10 } }]));
    unmount();
    expect(document.body.dataset.stickyAtc).toBeUndefined();
  });
});
