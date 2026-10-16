/**
 * Trust strip: merchant-written items, OFF by default for new stores.
 *
 * Discriminator (migration-free): `trustStrip.items` ABSENT = a store that
 * predates this change, so it keeps the three fixed legacy items; PRESENT
 * (even `[]`) = merchant-owned, only their items render, none = hidden.
 * New stores are provisioned with `items: []` (NEW_STORE_LAYOUT_SETTINGS).
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  layoutToDefinition,
  definitionToLayout,
  resolveLayoutSettings,
  sectionFromPreset,
  NEW_STORE_LAYOUT_SETTINGS,
  storeLayoutSchema,
  getSectionDefinition,
} from '@ebda/shared';

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

const STORE = {
  id: 's',
  name: 'Shop',
  nameAr: 'متجر',
  template: 'modern',
  theme: {},
  currency: 'EGP',
  blogEnabled: false,
  description: null,
  heroImage: null,
};

function render(raw: unknown, opts: { editorMode?: boolean; language?: 'en' | 'ar' } = {}) {
  ctx.store = STORE;
  ctx.language = opts.language ?? 'en';
  // The way production delivers a layout: stored JSON resolved against the template.
  const layout = resolveLayoutSettings(JSON.parse(JSON.stringify(raw)), 'modern');
  return renderToStaticMarkup(
    <PageRenderer
      definition={layoutToDefinition(layout)}
      templateId="modern"
      featuredProducts={[]}
      newArrivals={[]}
      bestSellers={[]}
      categories={[]}
      testimonials={[]}
      editorMode={opts.editorMode}
    />
  );
}

describe('new store: no trust strip until the merchant writes items', () => {
  it('hides the strip on the public storefront', () => {
    const html = render(NEW_STORE_LAYOUT_SETTINGS);
    expect(html).not.toContain('Why shop with us');
    expect(html).not.toContain('Fast Delivery');
    expect(html).not.toContain('24/7 Support');
  });

  it('shows the EmptySectionHint in the editor canvas only', () => {
    const ed = render(NEW_STORE_LAYOUT_SETTINGS, { editorMode: true });
    expect(ed).toContain('data-empty-section="trustStrip"');
    expect(ed).toContain('Write your own trust items');
    expect(ed).not.toContain('Fast Delivery');
  });

  it('Egyptian Arabic hint', () => {
    const ed = render(NEW_STORE_LAYOUT_SETTINGS, { editorMode: true, language: 'ar' });
    expect(ed).toContain('اكتب نقاط الثقة الخاصة بك');
  });

  it('is what provisioning and StoreService.create write to stores.layout_settings', () => {
    for (const f of ['provisioning.service.ts', 'store.service.ts']) {
      const src = readFileSync(join(__dirname, '../../apps/api/src/services', f), 'utf8');
      expect(src, f).toContain('layoutSettings: NEW_STORE_LAYOUT_SETTINGS');
    }
    expect(NEW_STORE_LAYOUT_SETTINGS).toEqual({ trustStrip: { items: [] } });
  });

  it('the stored value survives the layout schema (Zod strips unlisted keys on PUT)', () => {
    const parsed = storeLayoutSchema.parse(NEW_STORE_LAYOUT_SETTINGS);
    expect(parsed.trustStrip?.items).toEqual([]);
  });
});

describe('existing store (no stored items): renders exactly the fixed defaults', () => {
  for (const [name, raw] of [
    ['empty layout column', {}],
    ['strip saved with style only', { trustStrip: { layout: 'vertical' } }],
  ] as const) {
    it(`${name}: three legacy items, EN and AR`, () => {
      const en = render(raw);
      expect(en).toContain('Fast Delivery');
      expect(en).toContain('Quality Guarantee');
      expect(en).toContain('24/7 Support');
      expect(render(raw, { language: 'ar' })).toContain('شحن سريع');
    });
  }

  it('does not show a hint in the editor either (it has real content)', () => {
    expect(render({}, { editorMode: true })).not.toContain('data-empty-section="trustStrip"');
  });
});

describe('merchant items', () => {
  const raw = {
    trustStrip: {
      items: [
        {
          icon: 'cod',
          title: 'Cash on delivery',
          titleAr: 'الدفع عند الاستلام',
          text: 'Pay at the door',
        },
        { title: 'Free returns', titleAr: 'استرجاع مجاني' },
      ],
    },
  };

  it('render in English with the merchant text only (no legacy defaults)', () => {
    const html = render(raw);
    expect(html).toContain('Cash on delivery');
    expect(html).toContain('Pay at the door');
    expect(html).toContain('Free returns');
    expect(html).not.toContain('Fast Delivery');
  });

  it('render in Arabic, falling back to the other language when a field is missing', () => {
    const html = render(raw, { language: 'ar' });
    expect(html).toContain('الدفع عند الاستلام');
    expect(html).toContain('استرجاع مجاني');
    expect(html).toContain('Pay at the door'); // no textAr: falls back to EN
  });

  it('items with no text at all are dropped; all dropped = strip hidden publicly', () => {
    const blank = { trustStrip: { items: [{ icon: 'gift' }, { title: '  ' }] } };
    expect(render(blank)).not.toContain('Why shop with us');
    expect(render(blank, { editorMode: true })).toContain('data-empty-section="trustStrip"');
  });

  it('a strip the merchant switched off shows neither strip nor hint', () => {
    const off = { trustStrip: { enabled: false, items: [] } };
    expect(render(off, { editorMode: true })).not.toContain('data-empty-section="trustStrip"');
  });
});

describe('editor model: items are blocks (add / remove / reorder)', () => {
  const def = getSectionDefinition('trust-strip')!;

  it('registry declares an `item` block with icon, bilingual title and subtitle', () => {
    expect(def.blocks.map(b => b.type)).toEqual(['item']);
    expect(def.blocks[0].maxCount).toBe(6);
    expect(def.blocks[0].settings.map(x => x.id)).toEqual(['icon', 'title', 'text']);
  });

  it('a strip added from the palette starts with no items (blocks = [])', () => {
    expect(sectionFromPreset('trust-strip', 0, 'ts-new').blocks).toEqual([]);
  });

  it('round-trips: absent stays absent, [] stays [], blocks reorder the items', () => {
    const legacy = definitionToLayout(layoutToDefinition(resolveLayoutSettings({}, 'modern')));
    expect(legacy.trustStrip?.items).toBeUndefined();

    const fresh = definitionToLayout(
      layoutToDefinition(resolveLayoutSettings(NEW_STORE_LAYOUT_SETTINGS, 'modern'))
    );
    expect(fresh.trustStrip?.items).toEqual([]);

    const doc = layoutToDefinition(
      resolveLayoutSettings(
        { trustStrip: { items: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] } },
        'modern'
      )
    );
    const node = doc.sections.find(s => s.type === 'trust-strip')!;
    expect(node.blocks!.map(b => b.type)).toEqual(['item', 'item', 'item']);
    node.blocks!.reverse();
    node.blocks![0].hidden = false;
    expect(definitionToLayout(doc).trustStrip?.items?.map(i => i.title)).toEqual(['C', 'B', 'A']);
  });
});
