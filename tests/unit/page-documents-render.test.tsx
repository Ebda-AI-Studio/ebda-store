// @vitest-environment jsdom
/**
 * Product page as a section document (Ruling VE-3 amended, VE-12): with no document, or with the default
 * one, the page renders exactly as before; a reordered, hidden or extended document changes only what
 * is around the pinned main block; the editor canvas marks every section.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { STORES } from '../fixtures/builder/homepage-data';
import { defaultPageDocument, reduceDocument, type PageDefinition } from '@ebda/shared';

const ctx = vi.hoisted(() => ({
  addItem: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  store: null as unknown as Record<string, unknown>,
  ioCallback: (() => {}) as (e: unknown[]) => void,
  all: [] as Array<(e: unknown[]) => void>,
}));

vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({
    store: ctx.store,
    layout: { reviewSection: { enabled: true } },
    isPlatform: false,
    isLoading: false,
  }),
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
  useFeatures: () => ({ isEnabled: () => true }),
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
// The three lazily loaded blocks become markers named after their module.
vi.mock('next/dynamic', () => ({
  default: (loader: () => Promise<unknown>) => {
    const name = /components\/(\w+)/.exec(String(loader))?.[1] ?? 'dynamic';
    return () => <div data-testid={name} />;
  },
}));
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
  faqs: [{ question: 'Does it shrink?', answer: 'Not after the first wash.' }],
  ...over,
});

async function mount(doc?: PageDefinition, opts: { editorMode?: boolean; template?: string } = {}) {
  vi.stubGlobal('IntersectionObserver', IO);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  const { default: ProductDetailClient } =
    await import('../../apps/web/src/app/products/[slug]/ProductDetailClient');
  const { PageDocumentProvider } = await import('../../apps/web/src/builder/render/PageDocument');
  ctx.store = { ...STORES.A, template: opts.template ?? 'qamar' };
  const page = (
    <ProductDetailClient
      initialProduct={product() as never}
      layout={{ reviewSection: { enabled: true } } as never}
    />
  );
  const { container } = render(
    doc ? (
      <PageDocumentProvider
        kind="product"
        initialDefinition={doc}
        editorMode={opts.editorMode}
        allowedOrigins={[]}
      >
        {page}
      </PageDocumentProvider>
    ) : (
      page
    )
  );
  return container;
}

/** The document order of the blocks the test can see, by their marker. */
function order(container: HTMLElement): string[] {
  const out: string[] = [];
  const seen = (el: Element): string | null =>
    el.getAttribute('data-testid') === 'ReviewSection'
      ? 'reviews'
      : el.getAttribute('data-testid') === 'FrequentlyBoughtTogether'
        ? 'bundles'
        : el.getAttribute('data-testid') === 'YouMightAlsoLike'
          ? 'recs'
          : el.getAttribute('data-testid') === 'pdp-add'
            ? 'main'
            : el.getAttribute('aria-labelledby') === 'product-faq-heading'
              ? 'faq'
              : null;
  container.querySelectorAll('*').forEach(el => {
    const s = seen(el);
    if (s && out[out.length - 1] !== s) out.push(s);
  });
  return out;
}

const withSections = (kind: 'product', fn: (d: PageDefinition) => PageDefinition) =>
  fn(defaultPageDocument(kind));

describe('product page document', () => {
  it('the default document renders byte-for-byte what no document renders', async () => {
    const bare = await mount();
    const bareHtml = bare.innerHTML;
    cleanup();
    const withDefault = await mount(defaultPageDocument('product'));
    expect(withDefault.innerHTML).toBe(bareHtml);
    expect(order(withDefault)).toEqual(['main', 'faq', 'reviews', 'bundles', 'recs']);
  });

  it('moving a section above the main block, and hiding another, changes only the order', async () => {
    const doc = withSections('product', d => {
      const r = reduceDocument(d, { type: 'moveSection', id: 'product-reviews', toIndex: 0 }).doc;
      return reduceDocument(r, { type: 'setSectionHidden', id: 'product-faq', hidden: true }).doc;
    });
    const c = await mount(doc);
    expect(order(c)).toEqual(['reviews', 'main', 'bundles', 'recs']);
  });

  it('a shared section added to the page renders where the document puts it', async () => {
    const doc = withSections('product', d => {
      const added = reduceDocument(d, {
        type: 'addSection',
        list: 'template',
        sectionType: 'image-text',
        presetIndex: 0,
        index: 1,
      }).doc;
      return {
        ...added,
        sections: added.sections.map(n =>
          n.type === 'image-text'
            ? { ...n, settings: { ...n.settings, body: 'Poured in small batches in Cairo.' } }
            : n
        ),
      };
    });
    const c = await mount(doc);
    expect(c.textContent).toContain('Poured in small batches in Cairo.');
    const text = c.textContent ?? '';
    expect(text.indexOf('Poured in small batches')).toBeGreaterThan(text.indexOf('Linen Abaya'));
    expect(text.indexOf('Poured in small batches')).toBeLessThan(text.indexOf('Product Q&A'));
  });

  it('the Dahab skin keeps its container for consecutive blocks and honours the order', async () => {
    const doc = withSections(
      'product',
      d => reduceDocument(d, { type: 'moveSection', id: 'product-reviews', toIndex: 0 }).doc
    );
    const c = await mount(doc, { template: 'dahab' });
    expect(order(c)[0]).toBe('reviews');
  });

  it('editor canvas: every section and the main block are marked, an empty one shows a placeholder', async () => {
    const doc = defaultPageDocument('product');
    const c = await mount(doc, { editorMode: true });
    for (const id of [
      'product-main',
      'product-faq',
      'product-reviews',
      'product-bundles',
      'product-recommendations',
    ])
      expect(c.querySelector(`[data-builder-id="${id}"]`), id).not.toBeNull();
    // related products: none loaded in this test, so the section is selectable through a placeholder
    expect(
      c.querySelector('[data-builder-id="product-related"] [data-empty-section="product-related"]')
    ).not.toBeNull();
    // and none of that exists on a public render
    cleanup();
    const pub = await mount(doc);
    expect(pub.querySelector('[data-builder-id]')).toBeNull();
    expect(pub.querySelector('[data-empty-section]')).toBeNull();
  });
});

describe('pageSectionsAround (cart and collection)', () => {
  it('cart: the recommendations sit after the cart, move above it, and need a slot to show on a public page', async () => {
    const { pageSectionsAround } = await import('../../apps/web/src/builder/render/PageDocument');
    const value = (doc: PageDefinition, editorMode = false) => ({
      kind: 'cart' as const,
      definition: doc,
      editorMode,
    });
    const slots = { 'cart-recommendations': <i data-x="recs" /> };
    const def = defaultPageDocument('cart');
    let r = pageSectionsAround(value(def), slots);
    expect(r.before).toEqual([]);
    expect(r.after.map(i => i.type)).toEqual(['cart-recommendations']);
    // an empty cart: the slot is null, nothing on a public page, a placeholder in the editor
    expect(pageSectionsAround(value(def), { 'cart-recommendations': null }).after).toEqual([]);
    expect(
      pageSectionsAround(value(def, true), { 'cart-recommendations': null }).after.map(i => i.type)
    ).toEqual(['cart-recommendations']);
    const moved = reduceDocument(def, {
      type: 'moveSection',
      id: 'cart-recommendations',
      toIndex: 0,
    }).doc;
    r = pageSectionsAround(value(moved), slots);
    expect(r.before.map(i => i.type)).toEqual(['cart-recommendations']);
    expect(r.after).toEqual([]);
  });

  it('collection: only shared sections can be added; an unknown or foreign type is skipped, never thrown', async () => {
    const { pageSectionsAround } = await import('../../apps/web/src/builder/render/PageDocument');
    const base = defaultPageDocument('collection');
    const withNewsletter = reduceDocument(base, {
      type: 'addSection',
      list: 'template',
      sectionType: 'newsletter',
      presetIndex: 0,
      index: 0,
    }).doc;
    const foreign = {
      ...withNewsletter,
      sections: [
        ...withNewsletter.sections,
        { id: 'x1', type: 'hero', settings: {} },
        { id: 'x2', type: 'from-a-newer-editor', settings: {} },
      ],
    };
    const r = pageSectionsAround(
      { kind: 'collection', definition: foreign, editorMode: false },
      {}
    );
    expect(r.before.map(i => i.type)).toEqual(['newsletter']);
    expect(r.after).toEqual([]);
  });
});
