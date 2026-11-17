// @vitest-environment jsdom
/**
 * QA-CART-UX-1: after "add to cart" the header badge moved at once but nothing confirmed it for 2+ seconds (the server
 * answer), so a phone shopper tapped again. The confirmation is now shown the same moment as the optimistic update (a
 * status with a link to the cart, in the page language), and a refused add retracts it, shows the error and restores
 * the badge from the server cart.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, act, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({
  addToCart: vi.fn(),
  getCart: vi.fn(),
  addToast: vi.fn(() => 'toast-1'),
  removeToast: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  lang: { value: 'ar' as 'ar' | 'en' },
}));

vi.mock('@/lib/api', () => ({
  api: { getCart: h.getCart, addToCart: h.addToCart, syncCart: vi.fn() },
}));
vi.mock('@ebda/ui', () => ({
  useToast: () => ({
    addToast: h.addToast,
    removeToast: h.removeToast,
    error: h.error,
    info: h.info,
    success: h.success,
  }),
}));
vi.mock('./LanguageContext', () => ({
  useLanguage: () => ({
    t: (en: string, ar: string) => (h.lang.value === 'ar' ? ar : en),
    language: h.lang.value,
  }),
}));
vi.mock('./StoreContext', () => ({ useStore: () => ({ store: { id: 'store-1' } }) }));

import { CartProvider, useCart } from './CartContext';

let api: ReturnType<typeof useCart>;
function Grab() {
  api = useCart();
  return <span data-testid="n">{api.items.length}</span>;
}
const ring = {
  id: 'p1',
  name: 'Ring',
  nameAr: 'خاتم',
  price: 485000,
  slug: 'ring',
  image: undefined,
  category: undefined,
  variantId: undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.lang.value = 'ar';
  window.history.pushState({}, '', '/products/ring');
  h.getCart.mockResolvedValue({ success: true, data: { cart: { items: [], bundles: [] } } });
});
afterEach(cleanup);

async function mount() {
  render(
    <CartProvider>
      <Grab />
    </CartProvider>
  );
  await act(async () => {});
}

describe('add to cart confirms immediately', () => {
  it('the status toast is shown BEFORE the server answers, with a link to the cart', async () => {
    let resolve!: (v: unknown) => void;
    h.addToCart.mockReturnValue(new Promise(r => (resolve = r)));
    await mount();
    let done: Promise<boolean>;
    act(() => {
      done = api.addItem(ring, 1);
    });
    // the server has not answered: the confirmation is already on screen
    expect(h.addToast).toHaveBeenCalledTimes(1);
    const toast = (h.addToast.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(toast.type).toBe('success');
    expect(toast.title).toBe('اتضاف للسلة ✓');
    expect(toast.message).toBe('خاتم');
    expect(toast.action).toEqual({ label: 'كمّل الشراء', href: '/cart' });
    await act(async () => {
      resolve({ success: true, data: { cart: { items: [], bundles: [] } } });
      await done;
    });
    expect(h.removeToast).not.toHaveBeenCalled();
    expect(h.error).not.toHaveBeenCalled();
  });

  it('the cart link follows the locale-path rule: the cart is not a prefixed route, so an /ar page links /cart', async () => {
    window.history.pushState({}, '', '/ar/products/ring');
    h.addToCart.mockResolvedValue({ success: true, data: { cart: { items: [], bundles: [] } } });
    await mount();
    await act(async () => {
      await api.addItem(ring, 1);
    });
    const toast = (h.addToast.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(toast.action.href).toBe('/cart');
  });

  it('English copy on an English page', async () => {
    h.lang.value = 'en';
    h.addToCart.mockResolvedValue({ success: true, data: { cart: { items: [], bundles: [] } } });
    await mount();
    await act(async () => {
      await api.addItem(ring, 1);
    });
    const toast = (h.addToast.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(toast.title).toBe('Added to cart ✓');
    expect(toast.message).toBe('Ring');
  });

  it('a refused add retracts the confirmation, shows the Egyptian error and restores the badge from the server', async () => {
    h.addToCart.mockResolvedValue({
      success: false,
      error: { code: 'OUT_OF_STOCK', message: 'no' },
    });
    await mount();
    const getCartBefore = h.getCart.mock.calls.length;
    let ok = true;
    await act(async () => {
      ok = await api.addItem(ring, 1);
    });
    expect(ok).toBe(false);
    expect(h.removeToast).toHaveBeenCalledWith('toast-1');
    expect(h.error).toHaveBeenCalledWith('الإضافة للسلة منفعتش', 'جرّب تاني.');
    // the badge is rolled back from the server cart (it was optimistic): the cart is re-read
    expect(h.getCart.mock.calls.length).toBeGreaterThan(getCartBefore);
  });

  it('a network failure does the same: retract, error, re-read the cart', async () => {
    h.addToCart.mockRejectedValue(new Error('network'));
    await mount();
    const getCartBefore = h.getCart.mock.calls.length;
    let ok = true;
    await act(async () => {
      ok = await api.addItem(ring, 1);
    });
    expect(ok).toBe(false);
    expect(h.removeToast).toHaveBeenCalledWith('toast-1');
    expect(h.error).toHaveBeenCalledTimes(1);
    expect(h.getCart.mock.calls.length).toBeGreaterThan(getCartBefore);
  });
});
