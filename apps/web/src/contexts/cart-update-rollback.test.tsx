// @vitest-environment jsdom
/**
 * STORE-QA-45: a refused (400) or throttled (429) quantity change must put back the number the server last accepted,
 * even when the reconciling refetch is throttled too, and the thrown error must carry the API code so the cart page can
 * say why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';

const serverItem = {
  id: 'ci1',
  productId: 'p1',
  quantity: 2,
  variantId: null,
  product: { id: 'p1', name: 'Ring', slug: 'ring', price: 5000, images: [] },
};
const api = vi.hoisted(() => ({
  getCart: vi.fn(),
  syncCart: vi.fn(),
  updateCartItem: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api }));
vi.mock('@ebda/ui', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('./LanguageContext', () => ({
  useLanguage: () => ({ t: (en: string) => en, language: 'en' }),
}));
vi.mock('./StoreContext', () => ({ useStore: () => ({ store: { id: 'store-1' } }) }));

import { CartProvider, useCart } from './CartContext';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    },
  });
  api.getCart.mockReset();
  api.updateCartItem.mockReset();
  api.getCart.mockResolvedValue({ success: true, data: { cart: { items: [serverItem] } } });
});
afterEach(() => cleanup());

let ctx!: ReturnType<typeof useCart>;
function Grab() {
  ctx = useCart();
  return <span data-testid="q">{ctx.items[0]?.quantity ?? 'none'}</span>;
}
const mount = async () => {
  const view = render(
    <CartProvider>
      <Grab />
    </CartProvider>
  );
  await act(async () => {});
  expect(view.getByTestId('q').textContent).toBe('2');
  return view;
};

describe('CartProvider.updateQuantity rollback', () => {
  it('a 429 puts the accepted quantity back, even when the refetch is throttled too, and keeps the code', async () => {
    const view = await mount();
    api.updateCartItem.mockResolvedValue({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'slow down' },
    });
    api.getCart.mockRejectedValue(new Error('429 on the refetch as well'));
    let thrown: (Error & { code?: string }) | undefined;
    await act(async () => {
      await ctx.updateQuantity('ci1', 9).catch(e => (thrown = e));
    });
    expect(thrown?.code).toBe('RATE_LIMITED');
    expect(view.getByTestId('q').textContent).toBe('2');
  });

  it('a network error also restores the accepted quantity', async () => {
    const view = await mount();
    api.updateCartItem.mockRejectedValue(new Error('offline'));
    api.getCart.mockRejectedValue(new Error('offline'));
    await act(async () => {
      await ctx.updateQuantity('ci1', 7).catch(() => {});
    });
    expect(view.getByTestId('q').textContent).toBe('2');
  });

  it('an accepted change shows the server quantity', async () => {
    const view = await mount();
    api.updateCartItem.mockResolvedValue({
      success: true,
      data: { cart: { items: [{ ...serverItem, quantity: 5 }] } },
    });
    await act(async () => {
      await ctx.updateQuantity('ci1', 5);
    });
    expect(view.getByTestId('q').textContent).toBe('5');
  });
});
