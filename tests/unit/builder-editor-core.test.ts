/**
 * Visual builder Phase 2 — the pure editor core in @ebda/shared:
 * document reducer (every action + registry invariants), undo/redo history
 * (cap, redo cleared, coalescing), the ebda-builder:v1 postMessage protocol
 * (origin/source/schema gate), the two document-only sections
 * (image-text, newsletter), the doc-only merge used by legacy saves, and the
 * template-family presets.
 */
import { describe, it, expect } from 'vitest';
import {
  layoutToDefinition,
  resolveLayoutSettings,
  reduceDocument,
  locateSection,
  createHistory,
  pushHistory,
  undo,
  redo,
  HISTORY_CAP,
  acceptMessage,
  childToParentSchema,
  parentToChildSchema,
  BUILDER_PROTOCOL,
  validateDefinitionSync,
  definitionToLayout,
  mergeDocumentOnlySections,
  applyTemplateFamily,
  TEMPLATE_FAMILIES,
  sectionFromPreset,
  type PageDefinition,
} from '@ebda/shared';
import { loadLayoutFixture } from '../fixtures/builder/homepage-data';

const base = (): PageDefinition =>
  layoutToDefinition(resolveLayoutSettings(loadLayoutFixture('default-flow'), 'qamar'));
const ok = (d: PageDefinition) => expect(validateDefinitionSync(d).errors).toEqual([]);

describe('document reducer', () => {
  it('adds a section from a preset at an index, visible, with a unique id, still valid', () => {
    const r = reduceDocument(base(), {
      type: 'addSection',
      list: 'template',
      sectionType: 'image-text',
      presetIndex: 0,
      index: 1,
    });
    expect(r.rejected).toBeUndefined();
    expect(r.createdId).toBe('image-text-1');
    expect(r.doc.sections[1]).toMatchObject({
      id: 'image-text-1',
      type: 'image-text',
      hidden: false,
    });
    ok(r.doc);
    const again = reduceDocument(r.doc, {
      type: 'addSection',
      list: 'template',
      sectionType: 'image-text',
      presetIndex: 1,
    });
    expect(again.createdId).toBe('image-text-2');
  });

  it('refuses a second hero (cardinality), a header in the template (group), an unknown type', () => {
    const d = base();
    expect(
      reduceDocument(d, {
        type: 'addSection',
        list: 'template',
        sectionType: 'hero',
        presetIndex: 0,
      }).rejected
    ).toBe('CARDINALITY');
    expect(
      reduceDocument(d, {
        type: 'addSection',
        list: 'template',
        sectionType: 'header',
        presetIndex: 0,
      }).rejected
    ).toBe('GROUP_MISMATCH');
    expect(
      reduceDocument(d, {
        type: 'addSection',
        list: 'template',
        sectionType: 'nope',
        presetIndex: 0,
      }).rejected
    ).toBe('UNKNOWN_TYPE');
    // refused actions return the SAME document
    expect(
      reduceDocument(d, {
        type: 'addSection',
        list: 'template',
        sectionType: 'hero',
        presetIndex: 0,
      }).doc
    ).toBe(d);
  });

  it('caps newsletters at 2 and product carousels at 8, including through duplicate', () => {
    let d = base();
    d = reduceDocument(d, {
      type: 'addSection',
      list: 'template',
      sectionType: 'newsletter',
      presetIndex: 0,
    }).doc;
    const dup = reduceDocument(d, { type: 'duplicateSection', id: 'newsletter-1' });
    expect(dup.createdId).toBe('newsletter-2');
    expect(reduceDocument(dup.doc, { type: 'duplicateSection', id: 'newsletter-1' }).rejected).toBe(
      'CARDINALITY'
    );
  });

  it('duplicates a section right after itself; a product carousel gets a fresh legacy id', () => {
    const d = base();
    const extra = d.sections.find(s => s.type === 'product-carousel')!;
    const r = reduceDocument(d, { type: 'duplicateSection', id: extra.id });
    const i = r.doc.sections.findIndex(s => s.id === extra.id);
    expect(r.doc.sections[i + 1].id).toBe(r.createdId);
    expect(r.doc.sections[i + 1].settings.id).toBe(r.createdId);
    ok(r.doc);
    // and the projection carries both carousels
    expect(definitionToLayout(r.doc).extraCarousels).toHaveLength(2);
  });

  it('moves (clamped), hides, removes; never mutates the input', () => {
    const d = base();
    const frozen = JSON.stringify(d);
    const moved = reduceDocument(d, { type: 'moveSection', id: 'testimonials', toIndex: -5 }).doc;
    expect(moved.sections[0].id).toBe('testimonials');
    const hidden = reduceDocument(moved, {
      type: 'setSectionHidden',
      id: 'hero',
      hidden: true,
    }).doc;
    expect(locateSection(hidden, 'hero')!.node.hidden).toBe(true);
    const removed = reduceDocument(hidden, { type: 'removeSection', id: 'brand-story' }).doc;
    expect(locateSection(removed, 'brand-story')).toBeNull();
    expect(JSON.stringify(d)).toBe(frozen);
  });

  it('settings: set, clear with undefined; per-viewport hidden + settings, cleaned up when empty', () => {
    let d = base();
    d = reduceDocument(d, {
      type: 'setSectionSetting',
      id: 'categories',
      key: 'title',
      value: 'Shop',
    }).doc;
    expect(locateSection(d, 'categories')!.node.settings.title).toBe('Shop');
    d = reduceDocument(d, {
      type: 'setSectionSetting',
      id: 'categories',
      key: 'title',
      value: undefined,
    }).doc;
    expect('title' in locateSection(d, 'categories')!.node.settings).toBe(false);
    d = reduceDocument(d, {
      type: 'setViewportHidden',
      id: 'hero',
      viewport: 'tablet',
      hidden: true,
    }).doc;
    expect(locateSection(d, 'hero')!.node.responsive).toEqual({ tablet: { hidden: true } });
    d = reduceDocument(d, {
      type: 'setViewportHidden',
      id: 'hero',
      viewport: 'tablet',
      hidden: undefined,
    }).doc;
    expect(locateSection(d, 'hero')!.node.responsive).toBeUndefined();
    d = reduceDocument(d, {
      type: 'setViewportSetting',
      id: 'categories',
      viewport: 'mobile',
      key: 'layout',
      value: 'grid',
    }).doc;
    expect(locateSection(d, 'categories')!.node.responsive?.mobile?.settings).toEqual({
      layout: 'grid',
    });
    ok(d);
  });

  it('blocks: add (cap 10), duplicate, move, hide, set, remove; foreign block types refused', () => {
    let d = base();
    const add = reduceDocument(d, { type: 'addBlock', sectionId: 'hero', blockType: 'slide' });
    expect(add.createdId).toBe('slide-3');
    d = add.doc;
    d = reduceDocument(d, {
      type: 'setBlockSetting',
      sectionId: 'hero',
      blockId: 'slide-3',
      key: 'image',
      value: 'https://media.ebda.app/x.jpg',
    }).doc;
    d = reduceDocument(d, {
      type: 'moveBlock',
      sectionId: 'hero',
      blockId: 'slide-3',
      toIndex: 0,
    }).doc;
    expect(locateSection(d, 'hero')!.node.blocks![0].id).toBe('slide-3');
    expect(definitionToLayout(d).hero.slides[0].image).toBe('https://media.ebda.app/x.jpg');
    d = reduceDocument(d, {
      type: 'setBlockHidden',
      sectionId: 'hero',
      blockId: 'slide-1',
      hidden: true,
    }).doc;
    expect(definitionToLayout(d).hero.slides).toHaveLength(2);
    const dup = reduceDocument(d, {
      type: 'duplicateBlock',
      sectionId: 'hero',
      blockId: 'slide-2',
    });
    expect(dup.createdId).toBe('slide-4');
    d = reduceDocument(dup.doc, { type: 'removeBlock', sectionId: 'hero', blockId: 'slide-4' }).doc;
    ok(d);
    expect(
      reduceDocument(d, { type: 'addBlock', sectionId: 'categories', blockType: 'slide' }).rejected
    ).toBe('BLOCK_NOT_SUPPORTED');
    for (let i = 0; i < 10; i++)
      d = reduceDocument(d, { type: 'addBlock', sectionId: 'hero', blockType: 'slide' }).doc;
    expect(locateSection(d, 'hero')!.node.blocks).toHaveLength(10);
  });
});

describe('history (undo / redo)', () => {
  it('undo/redo walk the stack; a new edit clears redo', () => {
    let h = createHistory(0);
    h = pushHistory(h, 1, { now: 0 });
    h = pushHistory(h, 2, { now: 5000 });
    h = undo(h);
    expect(h.present).toBe(1);
    h = redo(h);
    expect(h.present).toBe(2);
    h = undo(h);
    h = pushHistory(h, 9, { now: 9000 });
    expect(h.future).toEqual([]);
    expect(redo(h)).toBe(h);
  });

  it('coalesces same-key edits inside the window into ONE undo step', () => {
    let h = createHistory('');
    h = pushHistory(h, 'h', { coalesceKey: 'hero.title', now: 0 });
    h = pushHistory(h, 'he', { coalesceKey: 'hero.title', now: 100 });
    h = pushHistory(h, 'hey', { coalesceKey: 'hero.title', now: 200 });
    expect(h.past).toEqual(['']);
    h = pushHistory(h, 'hey!', { coalesceKey: 'hero.title', now: 5000 });
    expect(h.past).toEqual(['', 'hey']);
    h = pushHistory(h, 'x', { coalesceKey: 'other', now: 5100 });
    expect(h.past).toEqual(['', 'hey', 'hey!']);
  });

  it(`keeps at most ${HISTORY_CAP} past states; the 101st edit drops the oldest`, () => {
    let h = createHistory(0);
    for (let i = 1; i <= HISTORY_CAP + 1; i++) h = pushHistory(h, i, { now: i * 10_000 });
    expect(h.past).toHaveLength(HISTORY_CAP);
    expect(h.past[0]).toBe(1);
  });
});

describe('ebda-builder:v1 protocol', () => {
  const parent = { id: 'parent' };
  const msg = { protocol: BUILDER_PROTOCOL, type: 'select', sectionId: 'hero' };
  it('accepts a valid message from the expected origin AND source only', () => {
    expect(
      acceptMessage(
        { origin: 'https://store.ebda.app', source: parent, data: msg },
        'https://store.ebda.app',
        parent,
        childToParentSchema
      )
    ).toEqual(msg);
    expect(
      acceptMessage(
        { origin: 'https://evil.example', source: parent, data: msg },
        'https://store.ebda.app',
        parent,
        childToParentSchema
      )
    ).toBeNull();
    expect(
      acceptMessage(
        { origin: 'https://store.ebda.app', source: { id: 'other' }, data: msg },
        'https://store.ebda.app',
        parent,
        childToParentSchema
      )
    ).toBeNull();
    expect(
      acceptMessage(
        { origin: 'https://store.ebda.app', source: parent, data: msg },
        null,
        parent,
        childToParentSchema
      )
    ).toBeNull();
  });
  it('rejects malformed payloads: wrong protocol, bad id, extra keys, oversized text', () => {
    const at = (data: unknown) =>
      acceptMessage({ origin: 'o', source: parent, data }, 'o', parent, childToParentSchema);
    expect(at({ ...msg, protocol: 'other' })).toBeNull();
    expect(at({ ...msg, sectionId: '<script>' })).toBeNull();
    expect(at({ ...msg, extra: 1 })).toBeNull();
    expect(
      at({
        protocol: BUILDER_PROTOCOL,
        type: 'patch-text',
        sectionId: 'hero',
        key: 'title',
        value: 'x'.repeat(3000),
      })
    ).toBeNull();
    expect(
      at({
        protocol: BUILDER_PROTOCOL,
        type: 'patch-text',
        sectionId: 'hero',
        key: '__proto__',
        value: 'x',
      })
    ).toBeNull();
  });
  it('the render message carries a schema-valid document only', () => {
    const p = (data: unknown) => parentToChildSchema.safeParse(data).success;
    expect(p({ protocol: BUILDER_PROTOCOL, type: 'render', definition: base() })).toBe(true);
    expect(
      p({ protocol: BUILDER_PROTOCOL, type: 'render', definition: { ...base(), schemaVersion: 9 } })
    ).toBe(false);
  });
});

describe('document-only sections', () => {
  it('image-text and newsletter validate, never project into layout_settings, and survive a legacy rebuild', () => {
    let d = base();
    d = reduceDocument(d, {
      type: 'addSection',
      list: 'template',
      sectionType: 'image-text',
      presetIndex: 0,
      index: 2,
    }).doc;
    d = reduceDocument(d, {
      type: 'addSection',
      list: 'template',
      sectionType: 'newsletter',
      presetIndex: 0,
    }).doc;
    ok(d);
    const layout = definitionToLayout(d);
    expect(JSON.stringify(layout)).not.toContain('Our story');
    // a legacy save rebuilds the document from layout_settings: the merge keeps them in place
    const rebuilt = mergeDocumentOnlySections(layoutToDefinition(layout), d);
    expect(rebuilt.sections.map(s => s.id)).toEqual(d.sections.map(s => s.id));
  });

  it('a predecessor that is gone puts the section first; ids already present win', () => {
    let d = base();
    d = reduceDocument(d, {
      type: 'addSection',
      list: 'template',
      sectionType: 'image-text',
      presetIndex: 0,
      index: 1,
    }).doc;
    const next = layoutToDefinition(definitionToLayout(d));
    next.sections = next.sections.filter(s => s.id !== 'hero');
    expect(mergeDocumentOnlySections(next, d).sections[0].id).toBe('image-text-1');
    expect(mergeDocumentOnlySections(d, d)).toEqual(d);
  });

  it('rejects physical alignment values, unsafe links and unknown settings', () => {
    const codes = (patch: Record<string, unknown>) => {
      const d = base();
      d.sections.push({
        ...sectionFromPreset('image-text', 0, 'it-x'),
        settings: { ...sectionFromPreset('image-text', 0, 'it-x').settings, ...patch },
      });
      return validateDefinitionSync(d).errors.map(e => e.code);
    };
    expect(codes({ imagePosition: 'left' })).toContain('PROPS_INVALID');
    expect(codes({ buttonLink: 'javascript:alert(1)' })).toContain('UNSAFE_URL');
    expect(codes({ image: 'data:image/png;base64,AA' })).toContain('UNSAFE_URL');
    expect(codes({ surprise: 1 })).toContain('PROPS_INVALID');
    expect(codes({})).toEqual([]);
  });
});

describe('template family presets', () => {
  it.each(TEMPLATE_FAMILIES.map(f => f.id))(
    '%s composes a valid draft that keeps the store data',
    id => {
      const cur = base();
      const doc = applyTemplateFamily(cur, id);
      ok(doc);
      const fam = TEMPLATE_FAMILIES.find(f => f.id === id)!;
      const templateTypes = fam.sectionTypes.filter(
        t => !['announcement', 'header', 'footer'].includes(t)
      );
      expect([...new Set(doc.sections.map(s => s.type))]).toEqual(templateTypes);
      // the merchant's hero (slides) is reused, not replaced
      if (templateTypes.includes('hero'))
        expect(doc.sections.find(s => s.type === 'hero')!.blocks).toEqual(
          cur.sections.find(s => s.type === 'hero')!.blocks
        );
      expect(doc.sectionGroups).toEqual(cur.sectionGroups);
      expect(doc.siteSettings).toEqual(cur.siteSettings);
    }
  );
});
