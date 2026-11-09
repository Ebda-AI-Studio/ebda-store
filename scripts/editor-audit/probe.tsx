/**
 * The flip probe (editor matrix, evidence source 2): render ONE section of a
 * skin through the real `PageRenderer` with `react-dom/server`, once per option
 * value of one setting, and report whether the HTML changed. It runs on a fixed
 * fixture store (3 products, 3 categories, bilingual copy), never touches the
 * network or a database, and strips generated ids so two renders of the same
 * input are identical.
 *
 * It must run under vitest (the storefront contexts are mocked with `vi.mock`,
 * exactly as `tests/unit/builder-homepage-characterization.test.tsx` does);
 * `npm run editor:matrix` therefore runs `tests/unit/editor-matrix.test.ts`.
 */
import { vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  layoutToDefinition,
  reduceDocument,
  resolveLayoutSettings,
  sectionFromPreset,
  type PageDefinition,
  type SectionNode,
  type SettingDefinition,
  type TemplateId,
} from '@ebda/shared';
import {
  STORES,
  PRODUCTS,
  CATEGORIES,
  TESTIMONIALS,
} from '../../tests/fixtures/builder/homepage-data';

const ctx = vi.hoisted(() => ({
  store: null as unknown as Record<string, unknown>,
  language: 'en' as 'en' | 'ar',
}));

vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: ctx.store, isPlatform: false, isLoading: false }),
  useStoreUrl: () => (p: string) => p,
  useStoreTheme: () => ctx.store.theme,
  useStoreTemplate: () => ctx.store.template,
  useIsPlatform: () => false,
  useStoreBranding: () => ({ name: ctx.store.name }),
  useStoreContact: () => ({}),
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    useLanguage: () => ({
      language: ctx.language,
      direction: ctx.language === 'ar' ? 'rtl' : 'ltr',
      isRtl: ctx.language === 'ar',
      setLanguage: () => {},
      t: (en: string, ar: string) => (ctx.language === 'ar' ? ar : en),
    }),
  };
});
vi.mock('../../apps/web/src/contexts/CartContext', () => ({
  useCart: () => ({
    items: [],
    bundles: [],
    itemCount: 0,
    subtotal: 0,
    addItem: () => {},
    removeItem: () => {},
    updateQuantity: () => {},
    clearCart: () => {},
    isOpen: false,
    openCart: () => {},
    closeCart: () => {},
  }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../../apps/web/src/components/ShopChrome', () => ({
  ShopChrome: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

const { PageRenderer } = await import('../../apps/web/src/builder/render/PageRenderer');

/** Fixture products with a second picture: the hover swap only renders when there is one to swap to. */
const PROBE_PRODUCTS = [
  ...PRODUCTS,
  // three plainly buyable products (the fixture's are out of stock or have variants): a routine's
  // "add all" button only exists when every step holds one
  ...['b1', 'b2', 'b3'].map(id => ({
    id,
    name: `Buyable ${id}`,
    nameAr: `منتج ${id}`,
    slug: id,
    price: 10000,
    images: [{ id: `img-${id}`, url: `https://pub-test.r2.dev/p/${id}.jpg`, alt: id }],
    inventory: 5,
    categories: [],
  })),
].map(p => ({
  ...p,
  images: [
    ...p.images,
    { id: `${p.id}-alt`, url: 'https://pub-test.r2.dev/p/hover.jpg', alt: 'alt' },
  ],
}));

/** Ids React and the renderers generate (`useId`, aria links) differ per render only by counter. */
const stable = (html: string) =>
  html
    .replace(/\b(id|for|aria-labelledby|aria-controls|aria-describedby)="[^"]*:[^"]*"/g, '')
    .replace(/\s+(id|for)="[^"]*"/g, '');

export interface ProbeResult {
  /** The values tried. */
  values: unknown[];
  differs: boolean;
  /** Set when a render threw: the control is reported `no-op` with this as evidence. */
  error?: string;
}

/** Values to flip a setting through; null when the probe cannot render it in isolation. */
export function probeValues(s: SettingDefinition): unknown[] | null {
  switch (s.type) {
    case 'select':
      return (s.options ?? []).map(o => o.value);
    case 'checkbox':
      return [false, true];
    case 'range':
      return [s.min ?? 0, s.max ?? 10];
    case 'color':
      return ['#112233', '#eecc99'];
    case 'text':
    case 'textarea':
      return ['Probe one', 'Probe two'];
    case 'image':
      return ['https://pub-test.r2.dev/p/probe1.jpg', 'https://pub-test.r2.dev/p/probe2.jpg'];
    case 'url':
      return ['/probe-one', '/probe-two'];
    default:
      return null;
  }
}

function renderSection(
  skin: TemplateId,
  doc: PageDefinition,
  language: 'en' | 'ar',
  editorMode = false,
  look?: string
): string {
  ctx.store = { ...STORES.A, template: skin, ...(look ? { look } : {}) };
  ctx.language = language;
  return stable(
    renderToStaticMarkup(
      <PageRenderer
        definition={doc}
        templateId={skin}
        featuredProducts={PROBE_PRODUCTS as never}
        newArrivals={PROBE_PRODUCTS.slice(0, 2) as never}
        bestSellers={[PROBE_PRODUCTS[2], PROBE_PRODUCTS[0]] as never}
        categories={CATEGORIES as never}
        testimonials={TESTIMONIALS}
        extraProducts={PROBE_PRODUCTS as never}
        editorMode={editorMode}
      />
    )
  );
}

/**
 * Content a section needs before its settings can show anything: a hero without slides,
 * a collection list without collections, a look without pieces render nothing, so every
 * flip would read as "no change". Blocks and base settings only; the setting under test
 * is set afterwards.
 */
function seedContent(type: string, node: SectionNode): SectionNode {
  const block = (btype: string, i: number, settings: Record<string, unknown>) => ({
    id: `${btype}-${i + 1}`,
    type: btype,
    settings,
  });
  const img = (n: number) => `https://pub-test.r2.dev/p/seed${n}.jpg`;
  switch (type) {
    case 'hero':
      return {
        ...node,
        blocks: [1, 2, 3].map((n, i) =>
          block('slide', i, {
            image: img(n),
            headline: `Seed headline ${n}`,
            headlineAr: `عنوان ${n}`,
            ctaText: 'Shop',
            ctaHref: '/products',
          })
        ),
      };
    case 'collection-list':
      return {
        ...node,
        blocks: ['nuts', 'dates', 'sweets'].map((slug, i) =>
          block('collection', i, { categorySlug: slug })
        ),
      };
    case 'gift-finder':
      // The chip rows exist only with an occasion (a category the store has) and a budget.
      return {
        ...node,
        blocks: [
          block('occasion', 0, { categorySlug: 'nuts', label: 'Seed occasion' }),
          block('budget', 1, { maxPrice: 500, label: 'Seed budget' }),
        ],
      };
    case 'shop-the-look':
      return {
        ...node,
        blocks: [0, 1].map(i =>
          block('look', i, { title: `Look ${i + 1}`, image: img(i + 1), productIds: ['p1', 'p2'] })
        ),
      };
    case 'steps':
      // Each step holds a buyable product, or the "add all" button the button text labels never shows.
      return {
        ...node,
        blocks: ['b1', 'b2', 'b3'].map((pid, i) =>
          block('step', i, { title: `Step ${i + 1}`, body: 'Seed body', productIds: [pid] })
        ),
      };
    case 'trust-strip':
      return {
        ...node,
        blocks: ['cod', 'shipping', 'returns'].map((icon, i) =>
          block('item', i, { icon, title: `Trust ${i + 1}` })
        ),
      };
    case 'image-text':
    case 'product-spotlight':
      return {
        ...node,
        settings: {
          heading: 'Seed heading',
          headingAr: 'عنوان',
          body: 'Seed body text',
          buttonText: 'Go',
          buttonLink: '/products',
          image: img(7),
          ...node.settings,
        },
      };
    case 'maker-profile':
      return {
        ...node,
        settings: {
          ...node.settings,
          variant: 'lead',
          name: 'Seed maker',
          nameAr: 'صانعة',
          role: 'Baker',
          story: 'A long story about the kitchen and the oven that has been going for years.',
          image: img(9),
        },
      };
    // T7 signature sections: the photos and the two filled rows each needs before it shows.
    case 'editorial-collage':
      return {
        ...node,
        blocks: [1, 2, 3].map((n, i) => block('photo', i, { image: img(n), alt: `Seed ${n}` })),
      };
    case 'piece-window':
    case 'spec-sheet':
    case 'key-ingredients':
    case 'kitchen-days': {
      const rows =
        type === 'spec-sheet'
          ? [0, 1].map(i => block('spec', i, { value: `${i + 6}`, label: `Seed spec ${i}` }))
          : type === 'key-ingredients'
            ? [0, 1].map(i => block('ingredient', i, { name: `Seed ${i}`, benefit: 'Seed use' }))
            : type === 'kitchen-days'
              ? [0, 1].map(i => block('day', i, { day: `Day ${i}`, dish: `Dish ${i}` }))
              : undefined;
      return {
        ...node,
        settings: {
          kicker: 'Seed kicker',
          subtitle: 'Seed subtitle',
          ...node.settings,
          ...(type === 'kitchen-days' ? {} : { image: img(8) }),
        },
        ...(rows ? { blocks: rows } : {}),
      };
    }
    case 'category-grid':
    case 'best-sellers':
    case 'new-arrivals':
    case 'product-carousel':
    case 'testimonials':
    case 'featured-collection':
      // A heading row with all three lines: the kicker / subtitle line toggles and the typography
      // zones have nothing to act on without text (the flip would read as "no change").
      return {
        ...node,
        settings: {
          title: 'Seed title',
          titleAr: 'عنوان',
          kicker: 'Seed kicker',
          kickerAr: 'نص',
          subtitle: 'Seed subtitle',
          subtitleAr: 'عنوان فرعي',
          ...node.settings,
        },
      };
    default:
      return node;
  }
}

/** A document holding only `type` (first preset), so a flip can only change that section. */
function isolated(skin: TemplateId, type: string): { doc: PageDefinition; id: string } {
  const base = layoutToDefinition(resolveLayoutSettings({}, skin));
  const id = `probe-${type}`;
  const node = seedContent(type, sectionFromPreset(type, 0, id));
  const doc: PageDefinition = {
    ...base,
    sectionGroups: { header: [], footer: [] },
    sections: [node],
  };
  return { doc, id };
}

/**
 * A control that is only SHOWN when another setting has a given value (the plan's `shownFor`):
 * it has to be flipped in that context, or it would read as dead. Keyed `type/key`, or `any/key` for every section.
 */
const PROBE_CONTEXT: Record<string, Record<string, unknown>> = {
  'hero/frame': { presentation: 'framed' },
  'hero/autoplayMs': { mode: 'slider' },
  // a source with enough products for the cap to cut anything
  'featured-collection/limit': { productSource: 'featured' },
  'any/cardFrameColor': { showCardFrame: true },
  'any/cardFrameSize': { showCardFrame: true },
  'any/cardFrameStyle': { showCardFrame: true },
  'any/cardFrameWidth': { showCardFrame: true },
};

/** Sections whose content comes from a network the probe does not have (the blog). */
export const PROBE_UNREACHABLE = new Set(['blog-carousel']);

/** Flip `key` of section `type` on `skin` through `values`; does the HTML change? */
export function probeSetting(
  skin: TemplateId,
  type: string,
  key: string,
  values: unknown[],
  /** Extra settings to apply first (a variant the control is only shown for). */
  context: Record<string, unknown> = {},
  /** The store's look, for a control only a look gives meaning to (aisle tints). */
  look?: string
): ProbeResult {
  try {
    const { doc: base, id } = isolated(skin, type);
    let doc = base;
    for (const [k, v] of Object.entries({
      ...(PROBE_CONTEXT[`${type}/${key}`] ?? PROBE_CONTEXT[`any/${key}`] ?? {}),
      ...context,
    }))
      doc = reduceDocument(doc, { type: 'setSectionSetting', id, key: k, value: v }).doc;
    // Compare within one language: English and Arabic always differ from each other.
    for (const language of ['en', 'ar'] as const) {
      const seen = new Set<string>();
      for (const value of values) {
        const r = reduceDocument(doc, { type: 'setSectionSetting', id, key, value });
        seen.add(renderSection(skin, r.doc, language, false, look));
      }
      if (seen.size > 1) return { values, differs: true };
    }
    return { values, differs: false };
  } catch (e) {
    return { values, differs: false, error: (e as Error).message.slice(0, 120) };
  }
}

/**
 * Is the merchant text or picture a setting renders carried by an explicit canvas
 * marker (`data-builder-setting` / `data-builder-image`)? Rendered in editor mode with a
 * known value: `absent` = the value is not shown at all, `marked`, or `unmarked` (the
 * canvas can only guess by matching text, or cannot target it). `key` ending in `Ar`
 * is rendered in Arabic.
 */
export function probeMarker(
  skin: TemplateId,
  type: string,
  key: string,
  settingType: string
): 'marked' | 'unmarked' | 'absent' {
  try {
    const { doc, id } = isolated(skin, type);
    const values =
      settingType === 'image' ? ['https://pub-test.r2.dev/p/probe1.jpg'] : ['Probe one'];
    const r = reduceDocument(doc, { type: 'setSectionSetting', id, key, value: values[0] });
    const html = renderSection(skin, r.doc, /Ar$/.test(key) ? 'ar' : 'en', true);
    const token = settingType === 'image' ? 'probe1.jpg' : 'Probe one';
    if (!html.includes(token)) return 'absent';
    const attr = settingType === 'image' ? 'data-builder-image' : 'data-builder-setting';
    return html.includes(`${attr}="${key}"`) ? 'marked' : 'unmarked';
  } catch {
    return 'absent';
  }
}
export function debugHtml(skin: TemplateId, type: string, key: string, value: unknown): string {
  const { doc, id } = isolated(skin, type);
  const r = reduceDocument(doc, { type: 'setSectionSetting', id, key, value });
  return renderSection(skin, r.doc, 'en');
}
