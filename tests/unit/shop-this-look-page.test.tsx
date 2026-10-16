// @vitest-environment jsdom
/**
 * W2a "Shop this look" (Ahmad 2026-10-16, amends Ruling B1-6): every shop-the-look panel ends in
 * one link to `/looks/<section>/<look>`, a page listing only that panel's pieces side by side,
 * each with its own size choice and its own add. Store-scoped: the panel comes from the store's
 * own document (hidden/missing/unsafe ids are null = 404), the pieces from a store-scoped fetch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PageDefinition } from '@ebda/shared';
import { PRODUCTS, STORES } from '../fixtures/builder/homepage-data';
import { findLookPanel, lookPanelPath } from '../../apps/web/src/lib/shop-the-look';

const ctx = vi.hoisted(() => ({
  store: null as unknown as Record<string, unknown>,
  addItem: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
}));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: ctx.store, layout: null, isPlatform: false, isLoading: false }),
  useStoreUrl: () => (p: string) => p,
  useStoreTheme: () => ctx.store.theme,
  useStoreTemplate: () => ctx.store.template,
  useStoreNumerals: () => undefined,
  useIsPlatform: () => false,
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
vi.mock('../../apps/web/src/contexts/CartContext', () => ({
  useCart: () => ({ items: [], itemCount: 0, total: 0, addItem: ctx.addItem }),
}));
vi.mock('../../apps/web/src/hooks/useLocalePrice', () => ({
  useLocalePrice: () => (n: number) => `${n / 100} ج.م`,
}));
vi.mock('../../apps/web/src/components', () => ({
  ShopChrome: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

const { LookPiecesClient } =
  await import('../../apps/web/src/app/looks/[sectionId]/[blockId]/LookPiecesClient');
const { ShopTheLookSection } =
  await import('../../apps/web/src/builder/sections/ShopTheLookSection');

afterEach(() => cleanup());

const lookBlock = (id: string, productIds: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  type: 'look',
  settings: { title: 'Linen', titleAr: 'كتان', image: '/l.webp', productIds },
  ...extra,
});
const doc = (sections: unknown[]) =>
  ({ schemaVersion: 1, pageKey: 'home', sections }) as unknown as PageDefinition;
const stl = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'stl',
  type: 'shop-the-look',
  settings: {},
  blocks,
  ...extra,
});

describe('findLookPanel: the panel comes from the store document only', () => {
  it('finds a visible panel and returns its pieces in order, deduped, at most 4', () => {
    const d = doc([stl([lookBlock('look-1', ['a', 'b', 'a', 'c', 'd', 'e', 7])])]);
    expect(findLookPanel(d, 'stl', 'look-1')).toMatchObject({
      title: 'Linen',
      titleAr: 'كتان',
      productIds: ['a', 'b', 'c', 'd'],
    });
  });
  it('null for a hidden section, a hidden block, a wrong type, no pieces or no document', () => {
    expect(findLookPanel(doc([stl([lookBlock('l', ['a'])], { hidden: true })]), 'stl', 'l')).toBe(
      null
    );
    expect(
      findLookPanel(doc([stl([lookBlock('l', ['a'], { hidden: true })])]), 'stl', 'l')
    ).toBeNull();
    expect(
      findLookPanel(doc([{ ...stl([lookBlock('l', ['a'])]), type: 'hero' }]), 'stl', 'l')
    ).toBeNull();
    expect(findLookPanel(doc([stl([lookBlock('l', [])])]), 'stl', 'l')).toBeNull();
    expect(findLookPanel(undefined, 'stl', 'l')).toBeNull();
    expect(findLookPanel(doc([stl([lookBlock('l', ['a'])])]), 'stl', 'other')).toBeNull();
  });
  it('refuses ids that are not builder node ids', () => {
    const d = doc([stl([lookBlock('l', ['a'])])]);
    expect(findLookPanel(d, '../x', 'l')).toBeNull();
    expect(findLookPanel(d, 'stl', 'l?x=1')).toBeNull();
  });
  it('the page path encodes both ids', () => {
    expect(lookPanelPath('stl', 'look-1')).toBe('/looks/stl/look-1');
  });
  it('the page 404s without a panel and is noindex', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../apps/web/src/app/looks/[sectionId]/[blockId]/page.tsx'),
      'utf8'
    );
    expect(src).toContain('if (!loaded) notFound();');
    expect(src).toContain('robots: { index: false, follow: true }');
  });
});

describe('the shop-the-look section links each panel to its page', () => {
  const setStore = () => {
    ctx.store = { ...STORES.A, template: 'qamar', look: null, currency: 'EGP', theme: {} };
  };
  const html = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      <ShopTheLookSection
        settings={{}}
        blocks={[lookBlock('look-1', ['p1', 'p3']), lookBlock('look-2', ['p3'])] as any}
        products={PRODUCTS as any}
        {...props}
      />
    );
  it('one "تسوّق هذا اللوك" link per panel, to /looks/<section>/<look>', () => {
    setStore();
    const out = html({ sectionId: 'stl' });
    expect(out.match(/data-part="shop-this-look"/g)?.length).toBe(2);
    expect(out).toContain('href="/looks/stl/look-1"');
    expect(out).toContain('href="/looks/stl/look-2"');
    expect(out).toContain('تسوّق هذا اللوك');
    // a quiet secondary link, never a second accent fill
    expect(out).toMatch(/data-part="shop-this-look"[^>]*border border-input/);
    expect(out).not.toMatch(/data-part="shop-this-look"[^>]*bg-primary/);
  });
  it('no link in the editor canvas or without a section id', () => {
    setStore();
    expect(html({ sectionId: 'stl', editorMode: true })).not.toContain('shop-this-look');
    expect(html({})).not.toContain('shop-this-look');
  });
});

describe('the look page: one buy block per piece', () => {
  const sized = {
    id: 's1',
    name: 'Linen abaya',
    nameAr: 'عباية كتان',
    slug: 'linen-abaya',
    price: 149000,
    inStock: true,
    images: [{ url: '/a.webp' }],
    options: [{ id: 'o1', name: 'Size', values: [{ value: 'S' }, { value: 'M' }] }],
    variants: [
      { id: 'v-s', price: 149000, inventory: 2, options: { Size: 'S' } },
      { id: 'v-m', price: 149000, inventory: 0, options: { Size: 'M' } },
    ],
  };
  const plain = { ...sized, id: 's2', slug: 'shawl', nameAr: 'شال', options: [], variants: [] };
  const noted = {
    ...plain,
    id: 's3',
    slug: 'embroidered',
    nameAr: 'مطرز',
    personalisation: { enabled: true, required: true, maxLength: 12 },
  };
  const soldOut = { ...plain, id: 's4', slug: 'gone', nameAr: 'نفد', inStock: false, inventory: 0 };
  const panel = {
    sectionId: 'stl',
    blockId: 'look-1',
    title: 'Linen',
    titleAr: 'كتان',
    image: '/l.webp',
    imageAr: '',
    alt: '',
    altAr: '',
    productIds: [],
  };
  const mount = (pieces: unknown[]) => {
    ctx.store = { ...STORES.A, template: 'qamar', theme: {} };
    ctx.addItem = vi.fn(async () => true);
    return render(<LookPiecesClient panel={panel} pieces={pieces as any} />);
  };

  it('lists only the panel pieces, side by side, each with its own add', () => {
    mount([sized, plain]);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('كتان');
    expect(document.querySelectorAll('[data-part="look-piece"]')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'أضف إلى السلة' })).toHaveLength(2);
    expect(document.querySelector('a[href="/products/linen-abaya"]')).not.toBeNull();
  });

  it('a sized piece added with no size: nothing is added and the missing choice is said', async () => {
    mount([sized]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'أضف إلى السلة' }));
    });
    expect(ctx.addItem).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('اختيار الخيارات أولًا');
  });

  it('after the size: one line with that variant', async () => {
    mount([sized]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^S/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'أضف إلى السلة' }));
    });
    expect(ctx.addItem).toHaveBeenCalledTimes(1);
    expect(ctx.addItem.mock.calls[0][0]).toMatchObject({ id: 's1', variantId: 'v-s' });
  });

  it('a piece with no options adds at once; a required note opens the PDP; sold out is disabled', async () => {
    mount([plain, noted, soldOut]);
    const buttons = screen.getAllByRole('button');
    await act(async () => {
      fireEvent.click(buttons[0]);
    });
    expect(ctx.addItem.mock.calls[0][0]).toMatchObject({ id: 's2', variantId: undefined });
    expect(screen.getByRole('link', { name: 'التخصيص من صفحة المنتج' }).getAttribute('href')).toBe(
      '/products/embroidered'
    );
    const gone = buttons.find(b => b.textContent === 'نفدت الكمية') as HTMLButtonElement;
    expect(gone.disabled).toBe(true);
  });

  it('the strings live in LanguageContext (ar + en)', () => {
    const lc = readFileSync(
      path.resolve(__dirname, '../../apps/web/src/contexts/LanguageContext.tsx'),
      'utf8'
    );
    for (const k of [
      "'Shop this look': 'تسوّق هذا اللوك'",
      "'Choose the options above first': 'اختيار الخيارات أولًا'",
      "'Personalise on the product page': 'التخصيص من صفحة المنتج'",
    ])
      expect(lc).toContain(k);
  });
});

// Review M-5 (W2a fix round 1): the store scoping is proven by RUNNING loadPanel against a mocked
// fetch, not by grepping its source: every call names the resolved store, only the panel's ids are
// asked for, an id the store's list did not return is never fetched, and a hidden panel or the
// platform host fetches no product at all.
describe('loadPanel (fetch mocked): store-scoped end to end', () => {
  const store = {
    id: 's1',
    domain: 'shop.example',
    isDemo: false,
    look: null,
  } as unknown as import('../../apps/web/src/lib/store-resolver').ResolvedStore;
  const panelDoc = (hidden = false) => ({
    schemaVersion: 1,
    pageKey: 'home',
    sectionGroups: { header: [], footer: [] },
    siteSettings: {},
    sections: [
      {
        id: 'stl',
        type: 'shop-the-look',
        settings: {},
        hidden,
        blocks: [
          {
            id: 'look-1',
            type: 'look',
            settings: { title: 'Linen', productIds: ['a', 'foreign'] },
          },
        ],
      },
    ],
  });
  const mockFetch = (doc: unknown) => {
    const calls: { url: string; headers?: Record<string, string> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        calls.push({ url, headers: init?.headers });
        const body = /\/layout$/.test(url)
          ? { data: { definition: doc } }
          : /products\?ids=/.test(url)
            ? { data: { products: [{ id: 'a', slug: 'linen-abaya' }] } } // 'foreign' not this store's
            : { data: { product: { id: 'a', slug: 'linen-abaya', name: 'Linen abaya' } } };
        return { ok: true, json: async () => body } as Response;
      })
    );
    return calls;
  };
  afterEach(() => vi.unstubAllGlobals());

  it('asks for the panel ids with the store headers and loads only what the store returned', async () => {
    const { loadPanel } =
      await import('../../apps/web/src/app/looks/[sectionId]/[blockId]/load-panel');
    const calls = mockFetch(panelDoc());
    const out = await loadPanel(store, 'stl', 'look-1');
    expect(out?.pieces.map(p => p.id)).toEqual(['a']);
    const product = calls.filter(c => c.url.includes('/public/products'));
    expect(product).toHaveLength(2);
    expect(decodeURIComponent(product[0].url)).toContain('/public/products?ids=a,foreign&limit=4');
    expect(product[1].url).toMatch(/\/public\/products\/linen-abaya$/);
    for (const c of product) expect(c.headers?.['X-Store-ID']).toBe('s1');
    expect(calls[0].url).toMatch(/\/public\/stores\/s1\/layout$/);
  });
  it('a hidden panel or the platform host fetches no product', async () => {
    const { loadPanel } =
      await import('../../apps/web/src/app/looks/[sectionId]/[blockId]/load-panel');
    let calls = mockFetch(panelDoc(true));
    expect(await loadPanel(store, 'stl', 'look-1')).toBeNull();
    expect(calls.some(c => c.url.includes('/public/products'))).toBe(false);
    calls = mockFetch(panelDoc());
    expect(await loadPanel({ ...store, id: 'demo' } as never, 'stl', 'look-1')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
