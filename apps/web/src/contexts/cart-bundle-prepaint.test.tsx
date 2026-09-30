// @vitest-environment jsdom
/**
 * #1563 — a bundle-only cart must pre-paint from localStorage like loose
 * items do, instead of showing "Your cart is empty" until GET /public/cart
 * lands (seconds on a cold API over mobile).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, act, cleanup } from '@testing-library/react';

let resolveCart: (v: unknown) => void = () => {};
vi.mock('@/lib/api', () => ({
  api: {
    getCart: vi.fn(() => new Promise(r => (resolveCart = r))),
    syncCart: vi.fn(),
  },
}));
vi.mock('@force/ui', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('./LanguageContext', () => ({
  useLanguage: () => ({ t: (en: string) => en, language: 'en' }),
}));
vi.mock('./StoreContext', () => ({ useStore: () => ({ store: { id: 'store-1' } }) }));

import { CartProvider, useCart, bundlesStorageKeyFor } from './CartContext';

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
});
afterEach(() => cleanup());

const BOX = {
  id: 'cb1',
  bundleId: 'b1',
  name: 'Ramadan Box',
  quantity: 1,
  unitPrice: 12000,
  total: 12000,
  available: 5,
};

function Probe() {
  const { bundles } = useCart();
  return <span data-testid="n">{bundles.length}</span>;
}

describe('CartProvider — bundle pre-paint', () => {
  it('paints cached bundles before the server cart answers', async () => {
    mem.set(bundlesStorageKeyFor('force-store-cart:store-1'), JSON.stringify([BOX]));
    const view = render(
      <CartProvider>
        <Probe />
      </CartProvider>
    );
    await act(async () => {});
    // Server call still pending — the cached bundle is already on screen.
    expect(view.getByTestId('n').textContent).toBe('1');
  });

  it('persists bundles once the server cart has answered', async () => {
    render(
      <CartProvider>
        <Probe />
      </CartProvider>
    );
    await act(async () => {
      resolveCart({
        success: true,
        data: { cart: { items: [], bundles: [{ ...BOX, image: null }] } },
      });
    });
    const saved = JSON.parse(mem.get(bundlesStorageKeyFor('force-store-cart:store-1')) ?? '[]');
    expect(saved).toHaveLength(1);
    expect(saved[0].bundleId).toBe('b1');
  });
});
