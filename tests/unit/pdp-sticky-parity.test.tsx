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
  // A marker, so X-03 can see whether the delivery line renders at all.
  DeliveryChip: () => <span data-testid="delivery-chip" />,
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

// jsdom has no scrollIntoView: tests install a mock on the prototype, put it back after each.
const realScrollIntoView = Element.prototype.scrollIntoView;
function mockScrollIntoView() {
  const fn = vi.fn();
  Element.prototype.scrollIntoView = fn;
  return fn;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (realScrollIntoView === undefined) {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  } else {
    Element.prototype.scrollIntoView = realScrollIntoView;
  }
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
  ctx.store = { ...STORES.A, template: 'qamar' };
  ctx.all.length = 0;
  render(<ProductDetailClient initialProduct={p as never} />);
  act(() =>
    ctx.all.forEach(cb => cb([{ isIntersecting: false, boundingClientRect: { top: -10 } }]))
  );
  // A sold-out product has no sticky bar at all (audit 2026-11-03 #6): the inline button is its one state.
  const sticky = screen.queryByTestId('sticky-atc') as HTMLElement;
  const stickyBtn = sticky?.querySelector('button') as HTMLButtonElement;
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

/** A product with two option axes, nothing pre-picked (several variants). */
const sized = {
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
};

describe('default PDP sticky bar mirrors the main add button', () => {
  it('enabled product: same label, both enabled', async () => {
    const { stickyBtn, main } = await renderPdp(product());
    expectMirror(main, stickyBtn, 'Add to cart', false);
  });

  it('required personalisation empty: both stay enabled-looking (the note is not a disabled reason)', async () => {
    const { stickyBtn, main } = await renderPdp(product(requiredNote));
    expectMirror(main, stickyBtn, 'Add to cart', false);
    fireEvent.change(document.querySelector('input[maxlength]') as HTMLInputElement, {
      target: { value: 'Sara' },
    });
    expectMirror(main, stickyBtn, 'Add to cart', false);
  });

  it.each(['main', 'sticky'] as const)(
    'tap on the %s button with the note missing: focuses the field, reveals the hint, never adds',
    async which => {
      const scrollSpy = mockScrollIntoView();
      const { stickyBtn, main } = await renderPdp(product(requiredNote));
      const input = document.querySelector('input[maxlength]') as HTMLInputElement;
      expect(screen.getByTestId('personalisation-hint').textContent).toBe('');
      await act(async () => {
        fireEvent.click(which === 'main' ? main : stickyBtn);
      });
      expect(ctx.addItem).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(input);
      expect(scrollSpy).toHaveBeenCalled();
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

  it('out of stock: ONE disabled "Out of stock" button, no second bar, stepper disabled, no repeated label', async () => {
    const { sticky, main } = await renderPdp(product({ inStock: false, inventory: 0 }));
    expect(sticky).toBeNull();
    expect(screen.queryByTestId('sticky-atc')).toBeNull();
    expect(main.textContent?.trim()).toBe('Out of stock');
    expect(main.disabled).toBe(true);
    expect((screen.getByLabelText('Decrease quantity') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Increase quantity') as HTMLButtonElement).disabled).toBe(true);
    // The label appears once: the button. The stock text beside the stepper only says "pre-order".
    expect(screen.getAllByText('Out of stock')).toHaveLength(1);
  });

  it('pre-order (out of stock, accepts backorder): same label, both enabled', async () => {
    const { stickyBtn, main } = await renderPdp(
      product({ inStock: false, inventory: 0, acceptsBackorder: true })
    );
    expectMirror(main, stickyBtn, 'Pre-order', false);
  });

  it('variant required (nothing picked yet): the real verb, both ENABLED (C-02)', async () => {
    // A choice the shopper can still make is not a reason to paint the buy
    // button disabled: `disabled` means the item cannot be bought.
    const { stickyBtn, main } = await renderPdp(product(sized));
    expectMirror(main, stickyBtn, 'Add to cart', false);
  });

  it.each(['main', 'sticky'] as const)(
    'C-02: tap on the %s button with no size: focus moves to the Size group, the live text appears, never adds',
    async which => {
      const scrollSpy = mockScrollIntoView();
      const { stickyBtn, main } = await renderPdp(product(sized));
      const sizeGroup = document.querySelector('[data-option-group="Size"]') as HTMLElement;
      const hint = sizeGroup.querySelector('[data-testid="variant-nudge"]') as HTMLElement;
      // The live region exists BEFORE it has text, so the message is announced.
      expect(hint.getAttribute('aria-live')).toBe('polite');
      expect(hint.textContent).toBe('');

      await act(async () => {
        fireEvent.click(which === 'main' ? main : stickyBtn);
      });

      expect(ctx.addItem).not.toHaveBeenCalled();
      expect(main.disabled).toBe(false);
      expect(stickyBtn.disabled).toBe(false);
      expect(document.activeElement).toBe(sizeGroup);
      expect(scrollSpy).toHaveBeenCalled();
      expect(hint.textContent).toBe('Choose Size');
      expect(sizeGroup.getAttribute('aria-describedby')).toBe(hint.id);
      // no aria-invalid: not an allowed attribute on role=group (ARIA 1.2)
      expect(sizeGroup.hasAttribute('aria-invalid')).toBe(false);
      expect(sizeGroup.className).toContain('ring-2');

      // Size picked, colour still missing: the next tap goes to Color.
      fireEvent.click(screen.getByRole('button', { name: 'M' }));
      expect(hint.textContent).toBe('');
      await act(async () => {
        fireEvent.click(which === 'main' ? main : stickyBtn);
      });
      const colorGroup = document.querySelector('[data-option-group="Color"]') as HTMLElement;
      expect(document.activeElement).toBe(colorGroup);
      expect(colorGroup.querySelector('[data-testid="variant-nudge"]')?.textContent).toBe(
        'Choose Color'
      );

      // Everything picked: the same tap adds THAT variant.
      fireEvent.click(screen.getByRole('button', { name: 'Sand' }));
      await act(async () => {
        fireEvent.click(which === 'main' ? main : stickyBtn);
      });
      expect(ctx.addItem).toHaveBeenCalledTimes(1);
      expect(ctx.addItem.mock.calls[0][0]).toMatchObject({ variantId: 'v2' });
    }
  );
});

describe('the task bar keeps a way to the cart (W1a fix round, minor 3)', () => {
  it('default PDP: the sticky bar carries a cart link (the tab bar it replaces was the phone cart entry)', async () => {
    const { sticky } = await renderPdp(product());
    const link = sticky.querySelector('[data-testid="sticky-atc-cart"]') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/cart');
    expect(link.getAttribute('aria-label')).toBe('Cart');
  });

  it('Dahab: the pinned bar carries one too', async () => {
    vi.stubGlobal('IntersectionObserver', IO);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const { default: ProductDetailClient } =
      await import('../../apps/web/src/app/products/[slug]/ProductDetailClient');
    ctx.store = { ...STORES.A, template: 'dahab' };
    render(<ProductDetailClient initialProduct={product() as never} />);
    const link = (await screen.findByTestId('dahab-pinned-cart')) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/cart');
    expect(link.getAttribute('aria-label')).toBe('Cart');
  });
});

describe('variants but NO option groups (W1a fix round, minor 1)', () => {
  it.each(['main', 'sticky'] as const)(
    'the %s button adds the first buyable variant (no picker to nudge, never a dead tap)',
    async which => {
      const { stickyBtn, main } = await renderPdp(
        product({
          options: [],
          variants: [
            { id: 'v-out', price: 149000, inventory: 0, options: {} },
            { id: 'v-ok', price: 149000, inventory: 4, options: {} },
          ],
        })
      );
      expectMirror(main, stickyBtn, 'Add to cart', false);
      await act(async () => {
        fireEvent.click(which === 'main' ? main : stickyBtn);
      });
      expect(ctx.addItem).toHaveBeenCalledTimes(1);
      expect(ctx.addItem.mock.calls[0][0]).toMatchObject({ variantId: 'v-ok' });
    }
  );
});

describe('Dahab PDP: the main and pinned buttons share the note nudge', () => {
  it.each(['pdp-add', 'dahab-pinned-add'])(
    '%s with the note missing: enabled, focuses the field, never adds',
    async testId => {
      mockScrollIntoView();
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

describe('Dahab PDP: the main and pinned buttons nudge the first unset option (C-02)', () => {
  it.each(['pdp-add', 'dahab-pinned-add'])(
    '%s with no size: enabled, focuses the Size group with live text, never adds',
    async testId => {
      mockScrollIntoView();
      vi.stubGlobal('IntersectionObserver', IO);
      vi.stubGlobal('localStorage', {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      });
      const { default: ProductDetailClient } =
        await import('../../apps/web/src/app/products/[slug]/ProductDetailClient');
      ctx.store = { ...STORES.A, template: 'dahab' };
      render(<ProductDetailClient initialProduct={product(sized) as never} />);
      const btn = (await screen.findByTestId(testId)) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      await act(async () => {
        fireEvent.click(btn);
      });
      expect(ctx.addItem).not.toHaveBeenCalled();
      const group = document.querySelector('[data-option-group="Size"]') as HTMLElement;
      expect(document.activeElement).toBe(group);
      expect(group.querySelector('[data-testid="variant-nudge"]')?.textContent).toBe('Choose Size');
    }
  );
});

describe('WhatsApp order button with the required note missing nudges the field (both PDP paths)', () => {
  it.each(['qamar', 'dahab'])(
    '%s: tap focuses the field, reveals the hint, opens nothing',
    async template => {
      const scrollSpy = mockScrollIntoView();
      vi.stubGlobal('IntersectionObserver', IO);
      vi.stubGlobal('localStorage', {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      });
      const { default: ProductDetailClient } =
        await import('../../apps/web/src/app/products/[slug]/ProductDetailClient');
      ctx.store = { ...STORES.A, template, whatsapp: '+201012345678' };
      render(<ProductDetailClient initialProduct={product(requiredNote) as never} />);
      const wa = (await screen.findByTestId('wa-me-product')) as HTMLElement;
      // Still marked disabled for assistive tech, but a real tappable control with no link target.
      expect(wa.getAttribute('aria-disabled')).toBe('true');
      expect(wa.getAttribute('href')).toBeNull();
      const input = document.querySelector('input[maxlength]') as HTMLInputElement;
      expect(screen.getByTestId('personalisation-hint').textContent).toBe('');
      await act(async () => {
        fireEvent.click(wa);
      });
      expect(document.activeElement).toBe(input);
      expect(scrollSpy).toHaveBeenCalled();
      expect(screen.getByTestId('personalisation-hint').textContent).toBe('Fill in “Name” first');
      expect(ctx.addItem).not.toHaveBeenCalled();
      // With the note typed it becomes the plain wa.me link.
      fireEvent.change(input, { target: { value: 'Sara' } });
      const link = screen.getByTestId('wa-me-product');
      expect(link.tagName).toBe('A');
      expect(link.getAttribute('href')).toContain('https://wa.me/');
      expect(link.getAttribute('aria-disabled')).toBeNull();
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
    // B0-49: button BELOW the fold on load -> the pinned bar is usable from first paint
    act(() => fireAll([{ isIntersecting: false, boundingClientRect: { top: 1100 } }]));
    expect(document.body.dataset.stickyAtc).toBe('1');
    const pinned = screen.getByTestId('dahab-pinned-add').closest('[aria-hidden]') as HTMLElement;
    expect(pinned.getAttribute('aria-hidden')).toBe('false');
    expect(pinned.hasAttribute('inert')).toBe(false);
    act(() => fireAll([{ isIntersecting: true, boundingClientRect: { top: 400 } }]));
    expect(document.body.dataset.stickyAtc).toBeUndefined();
    expect(pinned.getAttribute('aria-hidden')).toBe('true');
    act(() => fireAll([{ isIntersecting: false, boundingClientRect: { top: -10 } }]));
    expect(document.body.dataset.stickyAtc).toBe('1');
    act(() => fireAll([{ isIntersecting: true, boundingClientRect: { top: 100 } }]));
    expect(document.body.dataset.stickyAtc).toBeUndefined();
    act(() => fireAll([{ isIntersecting: false, boundingClientRect: { top: -10 } }]));
    unmount();
    expect(document.body.dataset.stickyAtc).toBeUndefined();
  });
});

/**
 * X-02 / X-03 (Lookbook/Vitrine taste gate): one `canBuyNow` for the selector,
 * both buttons and the delivery line, on both PDP paths.
 */
const backorderSized = {
  options: [{ id: 'o1', name: 'Size', values: [{ value: 'S' }, { value: 'M' }] }],
  variants: [
    // S is sold out but the merchant takes backorders on it: a pre-order.
    {
      id: 'v1',
      price: 149000,
      inventory: 0,
      inStock: false,
      acceptsBackorder: true,
      options: { Size: 'S' },
    },
    { id: 'v2', price: 149000, inventory: 3, inStock: true, options: { Size: 'M' } },
  ],
};

describe('X-02: a sold-out size that accepts backorder stays pickable (pre-order)', () => {
  it.each(['qamar', 'dahab'] as const)('%s PDP', async template => {
    vi.stubGlobal('IntersectionObserver', IO);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const { default: ProductDetailClient } =
      await import('../../apps/web/src/app/products/[slug]/ProductDetailClient');
    ctx.store = { ...STORES.A, template };
    render(<ProductDetailClient initialProduct={product(backorderSized) as never} />);
    const s = (await screen.findAllByRole('button', { name: /^S\b/ }))[0] as HTMLButtonElement;
    expect(s.disabled).toBe(false);
    fireEvent.click(s);
    const main = (
      template === 'dahab'
        ? screen.getAllByRole('button', { name: 'Pre-order' })[0]
        : screen.getByTestId('pdp-add')
    ) as HTMLButtonElement;
    expect(main.textContent?.trim()).toBe('Pre-order');
    expect(main.disabled).toBe(false);
    // No "Out of stock" panel under the selector for a buyable pre-order.
    expect(screen.queryByText('Out of stock')).toBeNull();
    expect(screen.queryAllByTestId('delivery-chip').length).toBeGreaterThan(0);
  });

  it('a sold-out size WITHOUT backorder is still disabled', async () => {
    const noBackorder = {
      ...backorderSized,
      variants: backorderSized.variants.map(v =>
        v.id === 'v1' ? { ...v, acceptsBackorder: false } : v
      ),
    };
    await renderPdp(product(noBackorder));
    const s = screen.getAllByRole('button', { name: /^S\b/ })[0] as HTMLButtonElement;
    expect(s.disabled).toBe(true);
  });
});

describe('X-03: the delivery-date line only on something that can be bought now', () => {
  it('in stock: shown', async () => {
    await renderPdp(product());
    expect(screen.queryAllByTestId('delivery-chip')).toHaveLength(1);
  });
  it('sold out, no backorder: hidden', async () => {
    await renderPdp(product({ inStock: false, inventory: 0 }));
    expect(screen.queryAllByTestId('delivery-chip')).toHaveLength(0);
  });
  it('sold out, accepts backorder: shown (a pre-order still ships)', async () => {
    await renderPdp(product({ inStock: false, inventory: 0, acceptsBackorder: true }));
    expect(screen.queryAllByTestId('delivery-chip')).toHaveLength(1);
  });
  it('Dahab, sold out, no backorder: hidden', async () => {
    vi.stubGlobal('IntersectionObserver', IO);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const { default: ProductDetailClient } =
      await import('../../apps/web/src/app/products/[slug]/ProductDetailClient');
    ctx.store = { ...STORES.A, template: 'dahab' };
    render(
      <ProductDetailClient initialProduct={product({ inStock: false, inventory: 0 }) as never} />
    );
    await screen.findByTestId('dahab-pinned-cart');
    expect(screen.queryAllByTestId('delivery-chip')).toHaveLength(0);
  });
});
