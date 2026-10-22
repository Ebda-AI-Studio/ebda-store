// @vitest-environment jsdom
/**
 * Phase B4, Ruling B4-4 on the PLP LIST view (final review P2-2): a dish already in the cart shows
 * - qty + in the list row, never a second "Add" that would silently add another unit; off a stepper
 * look the row keeps its single Add button, byte-identical.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

const state = vi.hoisted(() => ({
  look: 'lamma.table' as string | null,
  items: [] as Array<Record<string, unknown>>,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  usePathname: () => '/',
}));
vi.mock('next/image', () => ({
  default: (p: Record<string, unknown>) => <span data-img={String(p.alt ?? '')} />,
}));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({
    store: { id: 's', look: state.look, currency: 'EGP', theme: {} },
    layout: {},
  }),
  useStoreUrl: () => (p: string) => p,
}));
vi.mock('../../apps/web/src/contexts/CartContext', () => ({
  useCart: () => ({
    items: state.items,
    updateQuantity: async () => {},
    removeItem: async () => {},
    addItem: async () => true,
  }),
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    useLanguage: () => ({
      language: 'ar',
      direction: 'rtl',
      isRtl: true,
      setLanguage: () => {},
      t: (_en: string, ar: string) => ar,
    }),
  };
});
vi.mock('../../apps/web/src/hooks/useLocalePrice', () => ({
  useLocalePrice: () => (n: number) => String(n),
}));
vi.mock('../../apps/web/src/hooks/useNumerals', () => ({
  useStoreNumerals: () => (v: unknown) => String(v),
}));
vi.mock('@ebda/ui', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, useToast: () => ({ addToast: () => {} }) };
});

const { CardStepperProvider } =
  await import('../../apps/web/src/templates/shared/card-stepper-context');
const { ProductListItem } = await import('../../apps/web/src/app/products/ProductListItem');

const product = {
  id: 'p1',
  name: 'Okra tagine',
  nameAr: 'طاجن بامية',
  slug: 'okra',
  price: 12000,
  inventory: 5,
  images: [],
  categories: [],
  variants: [],
} as never;
const line = {
  id: 'line-1',
  productId: 'p1',
  name: 'Okra tagine',
  nameAr: 'طاجن بامية',
  price: 12000,
  quantity: 2,
  slug: 'okra',
};
const row = () => (
  <CardStepperProvider>
    <ProductListItem
      product={product}
      isInCompare={false}
      onToggleCompare={() => {}}
      onAddToCart={() => {}}
    />
  </CardStepperProvider>
);

const addButtons = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('button')).filter(b =>
    /(إضافة|أضف|السلة)/.test(b.textContent ?? '')
  );

beforeEach(() => {
  state.look = 'lamma.table';
  state.items = [line];
});
afterEach(cleanup);

describe('PLP list view and the card stepper', () => {
  it('a dish in the cart shows - qty + and no second Add', () => {
    const { container, getByRole } = render(row());
    expect(container.querySelector('[data-cta="stepper"]')).not.toBeNull();
    expect(getByRole('status').textContent).toBe('2');
    expect(addButtons(container)).toHaveLength(0);
  });
  it('a dish not in the cart keeps the one Add button', () => {
    state.items = [];
    const { container } = render(row());
    expect(container.querySelector('[data-cta="stepper"]')).toBeNull();
    expect(addButtons(container)).toHaveLength(1);
  });
  it('off a stepper look the row is unchanged even with the dish in the cart', () => {
    state.look = 'qamar.atelier';
    const { container } = render(row());
    expect(container.querySelector('[data-cta="stepper"]')).toBeNull();
  });
});
