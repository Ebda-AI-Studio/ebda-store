/**
 * Editor bug 6: "a fresh store shows empty sections".
 *
 * A brand-new store has no products, reviews, posts or description. The public
 * storefront must then render NO empty section shell (and no stray divider
 * next to a missing section); the editor canvas keeps the section visible with
 * a hint so the merchant knows what fills it. Content is never invented: the
 * fix hides, it does not seed marketing copy.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { layoutToDefinition, resolveLayoutSettings } from '@ebda/shared';
import { PRODUCTS, CATEGORIES, TESTIMONIALS } from '../fixtures/builder/homepage-data';

const ctx = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
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
  useCart: () => ({ addItem: () => {} }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { PageRenderer } = await import('../../apps/web/src/builder/render/PageRenderer');
const { ImageTextSection } = await import('../../apps/web/src/builder/sections/ImageTextSection');
const { translations } = await import('../../apps/web/src/contexts/LanguageContext');

const FRESH_STORE = {
  id: 'fresh',
  name: 'Fresh Store',
  nameAr: 'متجر جديد',
  template: 'modern',
  theme: {},
  currency: 'EGP',
  blogEnabled: false,
  description: null,
  descriptionAr: null,
  heroImage: null,
};

// Every between-section divider switched on, so a stray one cannot hide behind
// "dividers are off by default".
const withDividers = () =>
  resolveLayoutSettings(
    {
      categories: { dividers: { above: { enabled: true } } },
      newArrivals: { dividers: { above: { enabled: true } } },
      bestSellers: { dividers: { above: { enabled: true } } },
      brandStory: { dividers: { above: { enabled: true } } },
      blogCarousel: { dividers: { above: { enabled: true } } },
      // Testimonials default OFF for new stores (fake-reviews posture); the
      // merchant opts in, so the empty-hint / render paths need it on here.
      testimonials: { enabled: true, dividers: { above: { enabled: true } } },
    } as never,
    'modern'
  );

function render(opts: {
  store?: Record<string, unknown>;
  empty?: boolean;
  editorMode?: boolean;
  language?: 'en' | 'ar';
}) {
  ctx.store = opts.store ?? FRESH_STORE;
  ctx.language = opts.language ?? 'en';
  const full = !opts.empty;
  return renderToStaticMarkup(
    <PageRenderer
      definition={layoutToDefinition(withDividers())}
      templateId="modern"
      featuredProducts={(full ? PRODUCTS : []) as never}
      newArrivals={(full ? PRODUCTS.slice(0, 2) : []) as never}
      bestSellers={(full ? [PRODUCTS[2], PRODUCTS[0]] : []) as never}
      categories={(full ? CATEGORIES : []) as never}
      testimonials={full ? TESTIMONIALS : []}
      editorMode={opts.editorMode}
    />
  );
}

const DATA_SECTIONS = ['categories', 'newArrivals', 'bestSellers', 'testimonials'] as const;

describe('public storefront of a brand-new store', () => {
  const html = render({ empty: true });

  it('renders no data-driven section shell', () => {
    for (const s of DATA_SECTIONS) expect(html).not.toContain(`data-section="${s}"`);
    expect(html).not.toContain('Our Story');
    expect(html).not.toContain('data-empty-section');
  });

  it('renders no divider next to a section that is not there', () => {
    // SectionDivider renders `<hr`; every divider slot was enabled above.
    expect(html).not.toContain('<hr');
  });

  it('keeps the hero, built from the store name (no invented copy)', () => {
    expect(html).toContain('data-section="hero"');
    expect(html).toContain('Fresh Store');
  });

  it('shows no editor hint text on the public page', () => {
    expect(html).not.toContain(translations['Add categories and they will appear here.']);
    expect(html).not.toContain('Add categories and they will appear here.');
  });
});

describe('editor canvas of a brand-new store', () => {
  const html = render({ empty: true, editorMode: true });

  it('keeps each empty data section visible with a hint', () => {
    for (const kind of ['categories', 'newArrivals', 'bestSellers', 'testimonials']) {
      expect(html).toContain(`data-empty-section="${kind}"`);
    }
    expect(html).toContain('Add categories and they will appear here.');
    expect(html).toContain('Only you see this in the editor.');
  });

  it('shows the brand-story hint only when the section is on and has no content', () => {
    expect(html).toContain('data-empty-section="brandStory"');
  });

  it('hints in Egyptian Arabic', () => {
    const ar = render({ empty: true, editorMode: true, language: 'ar' });
    expect(ar).toContain('أضف أقساماً وستظهر هنا.');
  });
});

describe('a store that has data', () => {
  const store = { ...FRESH_STORE, description: 'Handmade dates', heroImage: null };
  const html = render({ store });

  it('renders the data sections normally, with no hint', () => {
    for (const s of DATA_SECTIONS) expect(html).toContain(`data-section="${s}"`);
    expect(html).not.toContain('data-empty-section');
  });

  it('shows the brand story from the store description', () => {
    expect(html).toContain('Handmade dates');
  });

  it('editor mode shows the real section, not the hint', () => {
    const ed = render({ store, editorMode: true });
    for (const s of DATA_SECTIONS) {
      expect(ed).toContain(`data-section="${s}"`);
      expect(ed).not.toContain(`data-empty-section="${s}"`);
    }
  });
});

describe('image-text with nothing in it', () => {
  it('is hidden publicly, still selectable in the editor', () => {
    ctx.store = FRESH_STORE;
    expect(renderToStaticMarkup(<ImageTextSection settings={{}} />)).toBe('');
    expect(renderToStaticMarkup(<ImageTextSection settings={{}} editorMode />)).toContain(
      'data-section="image-text"'
    );
  });

  it('with text but no image shows the text and no grey placeholder box', () => {
    ctx.store = FRESH_STORE;
    const pub = renderToStaticMarkup(<ImageTextSection settings={{ heading: 'Hello' }} />);
    expect(pub).toContain('Hello');
    expect(pub).not.toContain('bg-muted');
  });
});

describe('provisioning defaults', () => {
  it('writes no sections or seeded content (only the new-store trust-strip layout), so a new store gets the data-driven default document', () => {
    const src = readFileSync(
      join(__dirname, '../../apps/api/src/services/provisioning.service.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/pageDefinition|builderDocument|tx\.product\.create/);
    // The one layout it writes is the trust strip switched off (items: []).
    expect(src).toMatch(/layoutSettings: NEW_STORE_LAYOUT_SETTINGS/);
    // The only content row it seeds is the one default category.
    expect(src).toMatch(/tx\.category\.create/);
  });

  it('every section of the default document is either data-driven (hidden when empty) or the name-built hero', () => {
    const types = layoutToDefinition(resolveLayoutSettings({}, 'modern')).sections.map(s => s.type);
    expect(types).not.toContain('image-text');
    expect(types).not.toContain('newsletter');
    expect(types).not.toContain('product-spotlight');
  });
});
