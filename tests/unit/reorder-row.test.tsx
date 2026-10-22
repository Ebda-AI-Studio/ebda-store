// @vitest-environment jsdom
/**
 * Phase B4 Task 4, Ruling B4-8: the "order again" row and the reorder-this-order button.
 * Anonymous, first-time and failed-request shoppers get NOTHING (no wrapper, no placeholder);
 * a customer gets the shared carousel in their own order with only what can be bought now;
 * the account button puts the still-orderable lines back through the normal add path and says in
 * one sentence what could not go back.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { reorderLines } from '../../apps/web/src/components/commerce/reorder-lines';

const ctx = vi.hoisted(() => ({
  signedIn: true,
  ids: [] as string[],
  idsOk: true,
  idsThrow: false,
  list: [] as Array<Record<string, unknown>>,
  addToCart: vi.fn(),
  getProducts: vi.fn(),
  refetchCart: vi.fn(async () => {}),
  push: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    prefetch: _p,
    ...r
  }: {
    children: React.ReactNode;
    href: string;
    prefetch?: boolean;
  }) => (
    <a href={href} {...r}>
      {children}
    </a>
  ),
}));
vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: ctx.push, replace: () => {}, prefetch: () => {} }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../../apps/web/src/lib/api', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    api: {
      getReorderProductIds: async () => {
        if (ctx.idsThrow) throw new Error('network');
        return ctx.idsOk ? { success: true, data: { productIds: ctx.ids } } : { success: false };
      },
      getProducts: (...a: unknown[]) => {
        ctx.getProducts(...a);
        return Promise.resolve({ success: true, data: { products: ctx.list } });
      },
      addToCart: (...a: unknown[]) => ctx.addToCart(...a),
    },
  };
});
vi.mock('../../apps/web/src/contexts/AuthContext', () => ({
  useOptionalAuth: () => ({
    isAuthenticated: ctx.signedIn,
    user: ctx.signedIn ? { id: 'c1' } : null,
  }),
}));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({
    store: { id: 's', template: 'lamma', look: 'lamma.table', currency: 'EGP', theme: {} },
    layout: undefined,
  }),
  useStoreUrl: () => (p: string) => p,
  useStoreNumerals: () => undefined,
}));
vi.mock('../../apps/web/src/contexts/CartContext', () => ({
  useCart: () => ({ items: [], refetchCart: ctx.refetchCart }),
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
vi.mock('@ebda/ui', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, useToast: () => ({ success: ctx.success, info: ctx.info, addToast: vi.fn() }) };
});

const { ReorderRow, orderedBuyable } =
  await import('../../apps/web/src/builder/sections/ReorderRow');
const { ReorderOrderButton } =
  await import('../../apps/web/src/components/commerce/ReorderOrderButton');

const prod = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Dish ${id}`,
  nameAr: `طبق ${id}`,
  slug: `dish-${id}`,
  price: 9000,
  images: [{ id: `i${id}`, url: `https://x/${id}.webp` }],
  inventory: 5,
  categories: [],
  ...extra,
});

beforeEach(() => {
  ctx.signedIn = true;
  ctx.ids = ['b', 'a', 'c'];
  ctx.idsOk = true;
  ctx.idsThrow = false;
  ctx.list = [prod('a'), prod('b'), prod('c')];
  ctx.addToCart.mockReset();
  ctx.getProducts.mockReset();
  ctx.push.mockReset();
  ctx.success.mockReset();
  ctx.info.mockReset();
});
afterEach(cleanup);

const row = () => (
  <ReorderRow pack="lamma" onAddToCart={async () => {}} sectionProps={{ className: 'py-8' }} />
);

describe('orderedBuyable (pure)', () => {
  it('keeps the customer order, drops what is gone, archived or cannot be bought now', () => {
    const got = orderedBuyable(['b', 'x', 'a', 'sold', 'gone', 'pre'], [
      prod('a'),
      prod('b'),
      prod('sold', { inventory: 0, inStock: false }),
      prod('gone', { status: 'archived' }),
      prod('pre', { inventory: 0, inStock: false, acceptsBackorder: true }),
    ] as never);
    expect(got.map(p => p.id)).toEqual(['b', 'a', 'pre']);
  });
});

describe('ReorderRow', () => {
  it('a customer with orders gets the shared carousel titled "اطلب تاني", in their order', async () => {
    const { container } = render(row());
    await waitFor(() => expect(container.querySelector('[data-section="reorder"]')).not.toBeNull());
    expect(container.querySelector('[data-section="reorder"]')!.className).toContain('py-8');
    expect(container.textContent).toContain('اطلب تاني');
    const names = Array.from(container.querySelectorAll('[data-zone="productName"]')).map(
      n => n.textContent
    );
    expect(names).toEqual(['طبق b', 'طبق a', 'طبق c']);
    expect(ctx.getProducts).toHaveBeenCalledWith({ ids: 'b,a,c', limit: '3' });
  });
  it('an anonymous shopper renders nothing and never calls the API', async () => {
    ctx.signedIn = false;
    const { container } = render(row());
    await new Promise(r => setTimeout(r, 30));
    expect(container.innerHTML).toBe('');
    expect(ctx.getProducts).not.toHaveBeenCalled();
  });
  it('a customer with no orders, a refused list, or a failed request renders nothing', async () => {
    for (const set of [
      () => (ctx.ids = []),
      () => (ctx.idsOk = false),
      () => (ctx.idsThrow = true),
      () =>
        (ctx.list = [prod('a', { inventory: 0, inStock: false })] as never) && (ctx.ids = ['a']),
    ]) {
      ctx.ids = ['a'];
      ctx.idsOk = true;
      ctx.idsThrow = false;
      ctx.list = [prod('a')];
      set();
      const { container } = render(row());
      await new Promise(r => setTimeout(r, 30));
      expect(container.innerHTML).toBe('');
      cleanup();
    }
  });
});

describe('reorderLines (pure)', () => {
  it('same product, variant, note and quantity; a bundle component is skipped; equal lines add up', () => {
    expect(
      reorderLines([
        { productId: 'p1', variantId: 'v1', quantity: 2, personalisation: ' بدون بصل ' },
        { productId: 'p1', variantId: 'v1', quantity: 1, personalisation: 'بدون بصل' },
        { productId: 'p2', quantity: 3 },
        { productId: 'box', quantity: 1, bundleGroupId: 'g1' },
        { productId: 'p3', quantity: 0 },
      ])
    ).toEqual([
      { productId: 'p1', variantId: 'v1', note: 'بدون بصل', quantity: 3 },
      { productId: 'p2', quantity: 3 },
    ]);
  });
});

describe('ReorderOrderButton', () => {
  const items = [
    { productId: 'p1', variantId: 'v1', quantity: 2, personalisation: 'بدون بصل' },
    { productId: 'p2', quantity: 1 },
    { productId: 'p3', quantity: 1 },
  ];
  it('adds every line through the normal add path with variant and note, then opens the cart', async () => {
    ctx.addToCart.mockResolvedValue({ success: true });
    const { getByRole } = render(<ReorderOrderButton items={items} />);
    fireEvent.click(getByRole('button', { name: 'إعادة الطلب' }));
    await waitFor(() => expect(ctx.push).toHaveBeenCalledWith('/cart'));
    expect(ctx.addToCart).toHaveBeenCalledWith('p1', 2, 'v1', 'بدون بصل');
    expect(ctx.addToCart).toHaveBeenCalledWith('p2', 1, undefined, undefined);
    expect(ctx.addToCart).toHaveBeenCalledTimes(3);
    expect(ctx.refetchCart).toHaveBeenCalledTimes(1);
    expect(ctx.success).toHaveBeenCalledTimes(1);
  });
  it('reports lines that could not go back in ONE sentence and still opens the cart', async () => {
    ctx.addToCart
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: { code: 'OUT_OF_STOCK' } })
      .mockRejectedValueOnce(new Error('gone'));
    const { getByRole } = render(<ReorderOrderButton items={items} />);
    fireEvent.click(getByRole('button', { name: 'إعادة الطلب' }));
    await waitFor(() => expect(ctx.push).toHaveBeenCalledWith('/cart'));
    expect(ctx.success).toHaveBeenCalledTimes(1);
    expect(ctx.success.mock.calls[0][1]).toContain('تعذّرت الإضافة');
    expect(ctx.success.mock.calls[0][1]).toContain('قطعتين مش متاحين دلوقتي');
  });
  it('adds nothing: stays on the page and says so', async () => {
    ctx.addToCart.mockResolvedValue({ success: false });
    const { getByRole } = render(<ReorderOrderButton items={items} />);
    fireEvent.click(getByRole('button', { name: 'إعادة الطلب' }));
    await waitFor(() => expect(ctx.info).toHaveBeenCalled());
    expect(ctx.push).not.toHaveBeenCalled();
  });
  it('an order with only bundle lines has no button', () => {
    const { container } = render(
      <ReorderOrderButton items={[{ productId: 'box', quantity: 1, bundleGroupId: 'g' }]} />
    );
    expect(container.innerHTML).toBe('');
  });
});
