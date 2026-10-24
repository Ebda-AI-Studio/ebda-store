/**
 * Characterization of the storefront homepage body (visual builder Phase 1).
 *
 * Written against the PRE-builder `HomePageContent` (hard-coded section
 * sequence) and committed with its snapshots BEFORE the PageRenderer refactor,
 * so the snapshots are the evidence that the refactor changes no output:
 * 6 layout fixtures x 2 stores x 5 templates x 2 languages, server-rendered
 * to static HTML and compared byte-for-byte (`toMatchFileSnapshot`).
 *
 * A layout reaches the component the way production delivers it: the API
 * resolves `stores.layout_settings` against the store's template baseline
 * (`public-store-layout.routes.ts`), and the storefront re-resolves the JSON
 * it receives (`HomePageBody.fetchLayoutSettings`).
 *
 * Mocked: the three client contexts (store, language, cart) — their providers
 * touch `document`/`localStorage` — `next/navigation`, and `ShopChrome`
 * (header/footer chrome is not part of the builder body and has its own
 * render tests). Everything else (5 template packs, shared sections, dividers,
 * spacing/bg/typography helpers) is the real code.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import path from 'node:path';
import {
  resolveLayoutSettings,
  layoutToDefinition,
  reduceDocument,
  type TemplateId,
} from '@ebda/shared';
import {
  LAYOUT_FIXTURES,
  TEMPLATES,
  STORES,
  PRODUCTS,
  CATEGORIES,
  TESTIMONIALS,
  loadLayoutFixture,
} from '../fixtures/builder/homepage-data';

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
  ShopChrome: ({ children }: { children?: React.ReactNode }) => (
    <div data-test="shop-chrome">{children}</div>
  ),
}));

const { HomePageContent } = await import('../../apps/web/src/app/HomePageContent');

const SNAP_DIR = path.join(__dirname, '..', 'fixtures', 'builder', '__snapshots__');

function renderHome(
  fixture: (typeof LAYOUT_FIXTURES)[number],
  storeKey: keyof typeof STORES,
  template: TemplateId,
  language: 'en' | 'ar',
  extraProps: Record<string, unknown> = {}
): string {
  ctx.store = { ...STORES[storeKey], template };
  ctx.language = language;
  // API: resolve against the template baseline. Storefront: re-resolve the JSON.
  const apiLayout = resolveLayoutSettings(loadLayoutFixture(fixture), template);
  const layout = resolveLayoutSettings(JSON.parse(JSON.stringify(apiLayout)));
  return renderToStaticMarkup(
    <HomePageContent
      templateId={template}
      featuredProducts={PRODUCTS as never}
      newArrivals={PRODUCTS.slice(0, 2) as never}
      bestSellers={[PRODUCTS[2], PRODUCTS[0]] as never}
      categories={CATEGORIES as never}
      testimonials={TESTIMONIALS}
      extraProducts={PRODUCTS as never}
      storeName={STORES[storeKey].name}
      layout={layout}
      {...extraProps}
    />
  );
}

describe('storefront homepage body: characterization (pins pre-builder output)', () => {
  for (const fixture of LAYOUT_FIXTURES) {
    it(`${fixture}: 2 stores x 5 templates x en/ar render exactly as before`, async () => {
      const parts: string[] = [];
      for (const storeKey of Object.keys(STORES) as Array<keyof typeof STORES>) {
        for (const template of TEMPLATES) {
          for (const language of ['en', 'ar'] as const) {
            const html = renderHome(fixture, storeKey, template, language);
            // Sanity: every render produced a homepage body, not an empty shell.
            expect(html.length).toBeGreaterThan(40);
            parts.push(
              `<!-- ${fixture} | store ${storeKey} | ${template} | ${language} -->\n${html}`
            );
          }
        }
      }
      await expect(parts.join('\n\n') + '\n').toMatchFileSnapshot(
        path.join(SNAP_DIR, `${fixture}.html`)
      );
    });
  }
});

describe('PageRenderer: the published-document path renders the same page', () => {
  const asStorefront = (fixture: (typeof LAYOUT_FIXTURES)[number], t: TemplateId) =>
    resolveLayoutSettings(
      JSON.parse(JSON.stringify(resolveLayoutSettings(loadLayoutFixture(fixture), t)))
    );

  it('a definition passed in (as the API returns it, through JSON) == the layout-derived render', () => {
    for (const fixture of LAYOUT_FIXTURES) {
      for (const template of TEMPLATES) {
        const def = JSON.parse(JSON.stringify(layoutToDefinition(asStorefront(fixture, template))));
        for (const language of ['en', 'ar'] as const) {
          expect(renderHome(fixture, 'A', template, language, { definition: def })).toBe(
            renderHome(fixture, 'A', template, language)
          );
        }
      }
    }
  });

  it('honours document order, including a carousel placed between fixed sections', () => {
    const def = layoutToDefinition(asStorefront('default-flow', 'qamar'));
    const extra = def.sections.findIndex(s => s.type === 'product-carousel');
    const [carousel] = def.sections.splice(extra, 1);
    def.sections.unshift(carousel);
    const html = renderHome('default-flow', 'A', 'qamar', 'en', { definition: def });
    expect(html.indexOf('data-section="extra:')).toBeLessThan(html.indexOf('data-section="hero"'));
  });

  it('tablet-only visibility emits the three-way classes; untouched sections keep legacy classes', () => {
    const def = layoutToDefinition(asStorefront('default', 'qamar'));
    def.sections.find(s => s.type === 'hero')!.responsive = { tablet: { hidden: true } };
    const html = renderHome('default', 'A', 'qamar', 'en', { definition: def });
    expect(html).toMatch(/data-section="hero"[^>]*class="md:max-lg:hidden"/);
    expect(html).not.toContain('max-md:hidden');
  });

  it('skips an unknown section type instead of throwing', () => {
    const def = layoutToDefinition(asStorefront('default', 'qamar'));
    def.sections.splice(2, 0, { id: 'future', type: 'video-hero', settings: { x: 1 } });
    expect(renderHome('default', 'A', 'qamar', 'en', { definition: def })).toBe(
      renderHome('default', 'A', 'qamar', 'en')
    );
  });

  it('a hidden section does not render its body', () => {
    const def = layoutToDefinition(asStorefront('default', 'qamar'));
    def.sections.find(s => s.type === 'new-arrivals')!.hidden = true;
    const html = renderHome('default', 'A', 'qamar', 'en', { definition: def });
    expect(html).not.toContain('data-section="newArrivals"');
    expect(renderHome('default', 'A', 'qamar', 'en')).toContain('data-section="newArrivals"');
  });
});

describe('builder render path stays out of the editor bundle', () => {
  it('nothing under apps/web/src/builder imports dnd-kit or the admin app', async () => {
    const fs = await import('node:fs');
    const dir = path.join(__dirname, '../../apps/web/src/builder');
    const files = fs.readdirSync(dir, { recursive: true }) as string[];
    const offenders = files
      .filter(f => /\.(ts|tsx)$/.test(f))
      .filter(f => /@dnd-kit|apps\/admin/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(files.some(f => f.endsWith('PageRenderer.tsx'))).toBe(true);
    expect(offenders).toEqual([]);
  });
});

describe('PageRenderer: document-only sections and the editor canvas markers', () => {
  const asStorefront = (t: TemplateId) =>
    resolveLayoutSettings(JSON.parse(JSON.stringify(resolveLayoutSettings({}, t))));

  it('image-text + newsletter render in document order on the PUBLIC page, with no editor markers', () => {
    let def = layoutToDefinition(asStorefront('qamar'));
    def = reduceDocument(def, {
      type: 'addSection',
      list: 'template',
      sectionType: 'image-text',
      presetIndex: 0,
      index: 1,
    }).doc;
    def = reduceDocument(def, {
      type: 'addSection',
      list: 'template',
      sectionType: 'newsletter',
      presetIndex: 0,
    }).doc;
    for (const t of TEMPLATES) {
      const html = renderHome('default', 'A', t, 'ar', { definition: def });
      expect(html).toContain('data-section="image-text"');
      expect(html).toContain('حكايتنا');
      expect(html.indexOf('data-section="hero"')).toBeLessThan(
        html.indexOf('data-section="image-text"')
      );
      expect(html.indexOf('data-section="image-text"')).toBeLessThan(
        html.indexOf('data-section="categories"')
      );
      expect(html).toContain('data-section="newsletter"');
      expect(html).not.toContain('data-builder-id');
    }
  });

  it('editor mode wraps every rendered section in a display:contents marker; hidden doc-only sections are skipped', () => {
    let def = layoutToDefinition(asStorefront('qamar'));
    def = reduceDocument(def, {
      type: 'addSection',
      list: 'template',
      sectionType: 'image-text',
      presetIndex: 0,
    }).doc;
    const html = renderHome('default', 'A', 'qamar', 'en', { definition: def, editorMode: true });
    for (const id of ['hero', 'categories', 'new-arrivals', 'best-sellers', 'image-text-1'])
      expect(html).toContain(`data-builder-id="${id}" style="display:contents"`);
    def = reduceDocument(def, { type: 'setSectionHidden', id: 'image-text-1', hidden: true }).doc;
    expect(renderHome('default', 'A', 'qamar', 'en', { definition: def })).not.toContain(
      'data-section="image-text"'
    );
  });
});
