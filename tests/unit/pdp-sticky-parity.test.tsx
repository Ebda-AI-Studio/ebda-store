// @vitest-environment jsdom
/**
 * Task 6 invariant: on the default PDP the phone sticky bar is NOT a second buy
 * path. Its label and disabled state are the main button's, always (one
 * `addDisabled`, one `addLabel`), including the required-personalisation gate.
 * Also pins the Dahab pinned bar's body flag.
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
  ctx.all.length = 0;
  render(<ProductDetailClient initialProduct={p as never} />);
  act(() =>
    ctx.all.forEach(cb => cb([{ isIntersecting: false, boundingClientRect: { top: -10 } }]))
  );
  const sticky = screen.getByTestId('sticky-atc');
  const stickyBtn = sticky.querySelector('button') as HTMLButtonElement;
  // The main button by its own hook, never by matching the sticky bar's label.
  const main = screen.getByTestId('pdp-add') as HTMLButtonElement;
  return { sticky, stickyBtn, main };
}

/** Both buttons carry exactly `label`, and the same disabled state. */
function expectMirror(
  main: HTMLButtonElement,
  sticky: HTMLButtonElement,
  label: string,
  disabled: boolean
) {
  expect(main.textContent?.trim()).toBe(label);
  expect(sticky.textContent?.trim()).toBe(label);
  expect(main.disabled).toBe(disabled);
  expect(sticky.disabled).toBe(disabled);
}

const requiredNote = {
  personalisation: {
    enabled: true,
    required: true,
    maxLength: 12,
    label: 'Name',
    labelAr: 'الاسم',
  },
};

describe('default PDP sticky bar mirrors the main add button', () => {
  it('enabled product: same label, both enabled', async () => {
    const { stickyBtn, main } = await renderPdp(product());
    expectMirror(main, stickyBtn, 'Add to Cart', false);
  });

  it('required personalisation empty: both stay enabled-looking (the note is not a disabled reason)', async () => {
    const { stickyBtn, main } = await renderPdp(product(requiredNote));
    expectMirror(main, stickyBtn, 'Add to Cart', false);
    fireEvent.change(document.querySelector('input[maxlength]') as HTMLInputElement, {
      target: { value: 'Sara' },
    });
    expectMirror(main, stickyBtn, 'Add to Cart', false);
  });

  it.each(['main', 'sticky'] as const)(
    'tap on the %s button with the note missing: focuses the field, reveals the hint, never adds',
    async which => {
      Element.prototype.scrollIntoView = vi.fn();
      const { stickyBtn, main } = await renderPdp(product(requiredNote));
      const input = document.querySelector('input[maxlength]') as HTMLInputElement;
      expect(screen.getByTestId('personalisation-hint').textContent).toBe('');
      await act(async () => {
        fireEvent.click(which === 'main' ? main : stickyBtn);
      });
      expect(ctx.addItem).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(input);
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
      expect(screen.getByTestId('personalisation-hint').textContent).toBe('Fill in “Name” first');
      // With the note typed, the same tap adds.
      fireEvent.change(input, { target: { value: 'Sara' } });
      await act(async () => {
        fireEvent.click(which === 'main' ? main : stickyBtn);
      });
      expect(ctx.addItem).toHaveBeenCalledTimes(1);
      expect(ctx.addItem.mock.calls[0][0]).toMatchObject({ note: 'Sara' });
    }
  );

  it('out of stock: same label and both disabled', async () => {
    const { stickyBtn, main } = await renderPdp(product({ inStock: false, inventory: 0 }));
    expectMirror(main, stickyBtn, 'Out of Stock', true);
  });

  it('pre-order (out of stock, accepts backorder): same label, both enabled', async () => {
    const { stickyBtn, main } = await renderPdp(
      product({ inStock: false, inventory: 0, acceptsBackorder: true })
    );
    expectMirror(main, stickyBtn, 'Pre-order', false);
  });

  it('variant required (nothing picked yet): same label, both disabled', async () => {
    const { stickyBtn, main } = await renderPdp(
      product({
        options: [
          { id: 'o1', name: 'Size', values: [{ value: 'S' }, { value: 'M' }] },
          { id: 'o2', name: 'Color', values: [{ value: 'Rose' }, { value: 'Sand' }] },
        ],
        variants: [
          { id: 'v1', price: 149000, inventory: 0, options: { Size: 'S', Color: 'Rose' } },
          { id: 'v2', price: 149000, inventory: 3, options: { Size: 'M', Color: 'Sand' } },
          { id: 'v3', price: 149000, inventory: 0, options: { Size: 'M', Color: 'Rose' } },
          { id: 'v4', price: 149000, inventory: 0, options: { Size: 'S', Color: 'Sand' } },
        ],
      })
    );
    expectMirror(main, stickyBtn, 'Select Options', true);
  });
});

describe('Dahab PDP: the main and pinned buttons share the note nudge', () => {
  it.each(['pdp-add', 'dahab-pinned-add'])(
    '%s with the note missing: enabled, focuses the field, never adds',
    async testId => {
      Element.prototype.scrollIntoView = vi.fn();
      vi.stubGlobal('IntersectionObserver', IO);
      vi.stubGlobal('localStorage', {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      });
      const { default: ProductDetailClient } =
        await import('../../apps/web/src/app/products/[slug]/ProductDetailClient');
      ctx.store = { ...STORES.A, template: 'dahab' };
      render(<ProductDetailClient initialProduct={product(requiredNote) as never} />);
      const btn = (await screen.findByTestId(testId)) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      if (testId === 'dahab-pinned-add') {
        // F10: solid ground, no glass, ease-out-quint.
        const bar = btn.closest('.fixed') as HTMLElement;
        expect(bar.className).not.toMatch(/backdrop-blur|bg-background\//);
        expect(bar.className).toContain('ease-[cubic-bezier(0.22,1,0.36,1)]');
      }
      await act(async () => {
        fireEvent.click(btn);
      });
      expect(ctx.addItem).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(document.querySelector('input[maxlength]'));
    }
  );
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
