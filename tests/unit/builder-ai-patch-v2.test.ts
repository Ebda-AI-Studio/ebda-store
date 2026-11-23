/**
 * Page-builder AI v2: the patch can add / move / remove blocks, point a section at a product list, a
 * category, an image or a link of THIS store, and fix a viewport; and it stays FILL-ONLY (NEVER-OVERWRITE-1):
 * the merchant's own words, pictures and links are never replaced. Every new op is still a draft edit
 * the merchant reviews; nothing here saves or publishes.
 */
import { describe, it, expect } from 'vitest';
import {
  aiPatchSchema,
  applyAiPatch,
  getSectionDefinition,
  layoutToDefinition,
  resolveLayoutSettings,
  validateDefinitionSync,
  type AiPatchAllow,
  type PageDefinition,
} from '@ebda/shared';
import { loadLayoutFixture } from '../fixtures/builder/homepage-data';

const base = (): PageDefinition =>
  layoutToDefinition(resolveLayoutSettings(loadLayoutFixture('default-flow'), 'qamar'));
const find = (d: PageDefinition, type: string) => d.sections.find(s => s.type === type)!;
const allow = (over: Partial<AiPatchAllow> = {}): AiPatchAllow => ({
  productIds: new Set(['p-1', 'p-2', 'p-3']),
  categorySlugs: new Set(['dates', 'bracelets']),
  imageUrls: new Set(['https://cdn.example/p-1.jpg']),
  linkPaths: new Set(['/products/ring', '/products']),
  ...over,
});

describe('blocks', () => {
  it('adds, moves and removes a hero slide, reporting each as a change', () => {
    const doc = base();
    const hero = find(doc, 'hero');
    const added = applyAiPatch(doc, [{ op: 'addBlock', sectionId: hero.id, blockType: 'slide' }]);
    expect(added.rejected).toEqual([]);
    const blocks = added.doc.sections.find(s => s.id === hero.id)!.blocks!;
    expect(blocks.length).toBe((hero.blocks?.length ?? 0) + 1);
    const created = added.changes[0]!.blockId!;
    expect(blocks.some(b => b.id === created)).toBe(true);
    const moved = applyAiPatch(added.doc, [
      { op: 'moveBlock', sectionId: hero.id, blockId: created, toIndex: 0 },
    ]);
    expect(moved.doc.sections.find(s => s.id === hero.id)!.blocks![0]!.id).toBe(created);
    const removed = applyAiPatch(moved.doc, [
      { op: 'removeBlock', sectionId: hero.id, blockId: created },
    ]);
    expect(
      removed.doc.sections.find(s => s.id === hero.id)!.blocks!.some(b => b.id === created)
    ).toBe(false);
    expect(validateDefinitionSync(removed.doc).errors).toEqual([]);
  });

  it('refuses a block type the section does not have, and a missing block', () => {
    const doc = base();
    const hero = find(doc, 'hero');
    const r = applyAiPatch(doc, [
      { op: 'addBlock', sectionId: hero.id, blockType: 'nonsense' },
      { op: 'moveBlock', sectionId: hero.id, blockId: 'nope', toIndex: 0 },
    ]);
    expect(r.rejected.map(x => x.reason)).toEqual(['BLOCK_NOT_SUPPORTED', 'NOT_FOUND']);
    expect(r.doc).toBe(doc);
  });
});

describe('setRef: only references of this store', () => {
  const carousel = (d: PageDefinition) => find(d, 'product-carousel');

  it('links a category and a product list the store has', () => {
    const doc = base();
    const c = carousel(doc);
    const r = applyAiPatch(
      doc,
      [
        {
          op: 'setRef',
          sectionId: c.id,
          key: 'categorySlug',
          kind: 'category',
          value: 'bracelets',
        },
        {
          op: 'setRef',
          sectionId: c.id,
          key: 'manualProductIds',
          kind: 'products',
          value: ['p-1', 'p-2'],
        },
      ],
      allow()
    );
    expect(r.rejected).toEqual([]);
    const next = carousel(r.doc);
    expect(next.settings.categorySlug).toBe('bracelets');
    expect(next.settings.manualProductIds).toEqual(['p-1', 'p-2']);
    expect(r.changes[0]).toMatchObject({ before: 'dates', after: 'bracelets' });
  });

  it('rejects an id, slug, image or link the model invented, and everything when no allow-list is given', () => {
    const doc = base();
    const c = carousel(doc);
    const ops = [
      { op: 'setRef', sectionId: c.id, key: 'categorySlug', kind: 'category', value: 'made-up' },
      {
        op: 'setRef',
        sectionId: c.id,
        key: 'manualProductIds',
        kind: 'products',
        value: ['p-1', 'ghost'],
      },
    ] as const;
    expect(applyAiPatch(doc, [...ops], allow()).rejected.map(x => x.reason)).toEqual([
      'NOT_ALLOWED',
      'NOT_ALLOWED',
    ]);
    expect(applyAiPatch(doc, [...ops]).rejected.map(x => x.reason)).toEqual([
      'NOT_ALLOWED',
      'NOT_ALLOWED',
    ]);
  });

  it('refuses a kind that does not match the setting, and a list sent to a single-value setting', () => {
    const doc = base();
    const c = carousel(doc);
    const r = applyAiPatch(
      doc,
      [
        {
          op: 'setRef',
          sectionId: c.id,
          key: 'categorySlug',
          kind: 'image',
          value: 'https://cdn.example/p-1.jpg',
        },
        { op: 'setRef', sectionId: c.id, key: 'categorySlug', kind: 'category', value: ['dates'] },
      ],
      allow()
    );
    expect(r.rejected.map(x => x.reason)).toEqual(['BAD_VALUE', 'BAD_VALUE']);
  });

  it("sets a slide image and link when empty, and never replaces the merchant's own", () => {
    const doc = base();
    const hero = find(doc, 'hero');
    const added = applyAiPatch(doc, [{ op: 'addBlock', sectionId: hero.id, blockType: 'slide' }]);
    const blockId = added.changes[0]!.blockId!;
    const set = applyAiPatch(
      added.doc,
      [
        {
          op: 'setRef',
          sectionId: hero.id,
          blockId,
          key: 'image',
          kind: 'image',
          value: 'https://cdn.example/p-1.jpg',
        },
        {
          op: 'setRef',
          sectionId: hero.id,
          blockId,
          key: 'link',
          kind: 'link',
          value: '/products/ring',
        },
      ],
      allow()
    );
    expect(set.rejected).toEqual([]);
    // the merchant now owns that picture: a second ask must not swap it
    const owned = JSON.parse(JSON.stringify(set.doc)) as PageDefinition;
    owned.sections
      .find(s => s.id === hero.id)!
      .blocks!.find(b => b.id === blockId)!.settings.image = 'https://merchant.example/own.jpg';
    const again = applyAiPatch(
      owned,
      [
        {
          op: 'setRef',
          sectionId: hero.id,
          blockId,
          key: 'image',
          kind: 'image',
          value: 'https://cdn.example/p-1.jpg',
        },
      ],
      allow()
    );
    expect(again.rejected.map(x => x.reason)).toEqual(['OVERWRITE_PROTECTED']);
    expect(
      again.doc.sections.find(s => s.id === hero.id)!.blocks!.find(b => b.id === blockId)!.settings
        .image
    ).toBe('https://merchant.example/own.jpg');
  });
});

describe('fill-only words (NEVER-OVERWRITE-1)', () => {
  it('a text the merchant wrote is never replaced; an empty one is filled', () => {
    const doc = base();
    const c = find(doc, 'product-carousel');
    expect(c.settings.title).toBe('Dates');
    const sd = getSectionDefinition('product-carousel')!;
    const emptyText = sd.settings.find(
      s => (s.type === 'text' || s.type === 'textarea') && c.settings[s.id] === undefined
    )!;
    const r = applyAiPatch(doc, [
      { op: 'setSectionSetting', id: c.id, key: 'title', value: 'Best dates in Egypt' },
      { op: 'setSectionSetting', id: c.id, key: emptyText.id, value: 'Fresh this week' },
    ]);
    expect(r.rejected).toEqual([{ index: 0, reason: 'OVERWRITE_PROTECTED' }]);
    expect(r.doc.sections.find(s => s.id === c.id)!.settings.title).toBe('Dates');
    expect(r.doc.sections.find(s => s.id === c.id)!.settings[emptyText.id]).toBe('Fresh this week');
  });

  it('placeholder copy counts as empty: the AI may replace it', () => {
    const doc = JSON.parse(JSON.stringify(base())) as PageDefinition;
    const c = find(doc, 'product-carousel');
    c.settings.title = 'Your text here';
    const r = applyAiPatch(doc, [
      { op: 'setSectionSetting', id: c.id, key: 'title', value: 'Dates from Siwa' },
    ]);
    expect(r.rejected).toEqual([]);
  });

  it('design choices (a colour, a number) are not words: still editable', () => {
    const doc = base();
    const hero = find(doc, 'hero');
    const r = applyAiPatch(doc, [
      { op: 'setSectionSetting', id: hero.id, key: 'bgColor', value: '#112233' },
    ]);
    expect(r.rejected).toEqual([]);
  });
});

describe('viewport fixes', () => {
  it('overrides a responsive setting for the phone only, and hides a section on the phone', () => {
    const doc = base();
    const hero = find(doc, 'hero');
    const pad = getSectionDefinition('hero')!.settings.find(s => s.id === 'paddingTop')!;
    const value = pad.options![0]!.value;
    const r = applyAiPatch(doc, [
      { op: 'setViewportSetting', id: hero.id, viewport: 'mobile', key: 'paddingTop', value },
      {
        op: 'setViewportHidden',
        id: find(doc, 'trust-strip').id,
        viewport: 'mobile',
        hidden: true,
      },
    ]);
    expect(r.rejected).toEqual([]);
    expect(
      r.doc.sections.find(s => s.id === hero.id)!.responsive?.mobile?.settings?.paddingTop
    ).toBe(value);
    expect(r.doc.sections.find(s => s.id === hero.id)!.settings.paddingTop).toBe(
      hero.settings.paddingTop
    );
    expect(validateDefinitionSync(r.doc).errors).toEqual([]);
  });

  it('refuses a setting that cannot differ per viewport', () => {
    const doc = base();
    const hero = find(doc, 'hero');
    const r = applyAiPatch(doc, [
      { op: 'setViewportSetting', id: hero.id, viewport: 'mobile', key: 'autoplayMs', value: 3000 },
    ]);
    expect(r.rejected.map(x => x.reason)).toEqual(['NOT_RESPONSIVE']);
  });
});

describe('schema', () => {
  it('accepts the new ops and still rejects free keys', () => {
    const ok = (op: unknown) =>
      aiPatchSchema.safeParse({ summaryEn: 'x', summaryAr: 'x', ops: [op] }).success;
    expect(ok({ op: 'addBlock', sectionId: 'hero', blockType: 'slide' })).toBe(true);
    expect(
      ok({ op: 'setRef', sectionId: 'a', key: 'image', kind: 'image', value: 'https://x' })
    ).toBe(true);
    expect(ok({ op: 'setRef', sectionId: 'a', key: 'image', kind: 'iframe', value: 'x' })).toBe(
      false
    );
    expect(ok({ op: 'setViewportSetting', id: 'a', viewport: 'desktop', key: 'k', value: 1 })).toBe(
      false
    );
    expect(ok({ op: 'addBlock', sectionId: 'hero', blockType: 'slide', extra: 1 })).toBe(false);
  });
});
