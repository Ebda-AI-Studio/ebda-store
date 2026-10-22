/**
 * Task 2 of the visual editor: which text an inline edit may write to (block
 * aware, direction per field, never a guess), and the parent-side re-check of
 * every `patch-text` intent (VE-2).
 */
import { describe, it, expect } from 'vitest';
import {
  BUILDER_PROTOCOL,
  childToParentSchema,
  intentToAction,
  layoutToDefinition,
  normalizeInlineText,
  reduceDocument,
  resolveLayoutSettings,
  textTargetIn,
  type PageDefinition,
} from '@ebda/shared';
import {
  inlineTargetFor,
  targetOf,
  type ElementLike,
} from '../../apps/web/src/builder/preview/overlay-logic';

function node(attrs: Record<string, string>, text = '', parent?: ElementLike): ElementLike {
  const self: ElementLike = {
    textContent: text,
    getAttribute: n => attrs[n] ?? null,
    closest: sel => {
      const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
      if (!m) return null;
      if (m[1] in attrs && (m[2] === undefined || attrs[m[1]] === m[2])) return self;
      return parent ? parent.closest(sel) : null;
    },
  };
  return self;
}

const doc = (): PageDefinition =>
  layoutToDefinition(
    resolveLayoutSettings(
      {
        hero: {
          enabled: true,
          slides: [
            { image: '/a.jpg', headline: 'Dates', headlineAr: 'تمور' },
            { image: '/b.jpg', headline: 'Boxes', headlineAr: 'علب' },
          ],
        },
      } as never,
      'modern'
    )
  );
const heroId = (d: PageDefinition) => d.sections.find(n => n.type === 'hero')!.id;

/** The DOM of hero slide 2 with its marked headline. */
function slideHeadline(d: PageDefinition, marker: string | null, text: string) {
  const section = node({ 'data-builder-id': heroId(d) });
  const slide = node({ 'data-builder-block': 'slide-2' }, '', section);
  return node(marker ? { 'data-builder-setting': marker } : {}, text, slide);
}

describe('inlineTargetFor', () => {
  it('a marked slide headline in Arabic resolves headlineAr, RTL', () => {
    const d = doc();
    const el = slideHeadline(d, 'headlineAr', 'علب');
    const hit = targetOf(el, d)!;
    expect(hit).toEqual({ sectionId: heroId(d), blockId: 'slide-2' });
    expect(inlineTargetFor(el, d, hit, 'ar')).toEqual({
      key: 'headlineAr',
      dir: 'rtl',
      multiline: false,
      max: 2048,
    });
  });

  it('an English field on an Arabic page keeps its own LTR direction', () => {
    const d = doc();
    const el = slideHeadline(d, 'headline', 'Boxes');
    const hit = targetOf(el, d)!;
    expect(inlineTargetFor(el, d, hit, 'ar')?.dir).toBe('ltr');
  });

  it('a marker that is not a text setting of THAT node is refused', () => {
    const d = doc();
    for (const bad of ['image', 'nope', 'title']) {
      const el = slideHeadline(d, bad, 'x');
      expect(inlineTargetFor(el, d, targetOf(el, d)!, 'en')).toBeNull();
    }
  });

  it('an unmarked text matches only when exactly one setting holds it', () => {
    let d = doc();
    // exact text of slide 2 in English -> headline
    const el = slideHeadline(d, null, ' Boxes ');
    expect(inlineTargetFor(el, d, targetOf(el, d)!, 'en')?.key).toBe('headline');
    // two settings of the block hold the same text -> never guess
    d = reduceDocument(d, {
      type: 'setBlockSetting',
      sectionId: heroId(d),
      blockId: 'slide-2',
      key: 'ctaText',
      value: 'Boxes',
    }).doc;
    const el2 = slideHeadline(d, null, 'Boxes');
    expect(inlineTargetFor(el2, d, targetOf(el2, d)!, 'en')).toBeNull();
    // text that matches nothing
    const el3 = slideHeadline(d, null, 'something else');
    expect(inlineTargetFor(el3, d, targetOf(el3, d)!, 'en')).toBeNull();
  });
});

describe('patch-text intent (parent side)', () => {
  const msg = (extra: Record<string, unknown>) =>
    childToParentSchema.parse({
      protocol: BUILDER_PROTOCOL,
      type: 'patch-text',
      sectionId: 'x',
      key: 'headline',
      value: 'v',
      ...extra,
    });

  it('turns a valid block edit into exactly one setBlockSetting, with a coalesce key', () => {
    const d = doc();
    const r = intentToAction(d, msg({ sectionId: heroId(d), blockId: 'slide-2', value: ' New ' }));
    expect(r).toEqual({
      action: {
        type: 'setBlockSetting',
        sectionId: heroId(d),
        blockId: 'slide-2',
        key: 'headline',
        value: 'New',
      },
      coalesce: `${heroId(d)}/slide-2/headline`,
    });
  });

  it('drops a key that is not a text setting of that block', () => {
    const d = doc();
    const id = heroId(d);
    expect(intentToAction(d, msg({ sectionId: id, blockId: 'slide-2', key: 'image' }))).toBeNull();
    expect(intentToAction(d, msg({ sectionId: id, blockId: 'slide-2', key: 'bogus' }))).toBeNull();
    // a section key sent for a block, and a block key sent for the section
    expect(
      intentToAction(d, msg({ sectionId: id, blockId: 'slide-2', key: 'sectionTitle' }))
    ).toBeNull();
    expect(intentToAction(d, msg({ sectionId: id, key: 'headline' }))).toBeNull();
  });

  it('drops an id that does not exist in the current document', () => {
    const d = doc();
    expect(intentToAction(d, msg({ sectionId: 'ghost' }))).toBeNull();
    expect(intentToAction(d, msg({ sectionId: heroId(d), blockId: 'slide-9' }))).toBeNull();
  });

  it('keeps a newline only in a textarea setting', () => {
    expect(normalizeInlineText('a\r\nb', false)).toBe('a b');
    expect(normalizeInlineText('a\nb', true)).toBe('a\nb');
    expect(normalizeInlineText('x'.repeat(3000), true)).toHaveLength(2048);
    const d = doc();
    expect(textTargetIn(d, heroId(d), 'slide-1', 'headlineAr')?.dir).toBe('rtl');
    expect(textTargetIn(d, heroId(d), 'slide-1', 'headline')?.multiline).toBe(false);
  });
});

describe('field limits (the save schema own)', () => {
  const stepsDoc = (): PageDefinition =>
    reduceDocument(doc(), {
      type: 'addSection',
      list: 'template',
      sectionType: 'steps',
      presetIndex: 0,
    }).doc;

  it('carries the limit of each field from its Zod schema', () => {
    const d = stepsDoc();
    const steps = d.sections.find(n => n.type === 'steps')!;
    const block = steps.blocks![0].id;
    expect(textTargetIn(d, steps.id, block, 'title')?.max).toBe(80);
    expect(textTargetIn(d, steps.id, block, 'bodyAr')?.max).toBe(240);
    const img = reduceDocument(d, {
      type: 'addSection',
      list: 'template',
      sectionType: 'image-text',
      presetIndex: 0,
    });
    expect(textTargetIn(img.doc, img.createdId!, undefined, 'heading')?.max).toBe(200);
  });

  it('the parent cuts an over-long edit at the field limit, never at the generic cap', () => {
    const d = stepsDoc();
    const steps = d.sections.find(n => n.type === 'steps')!;
    const block = steps.blocks![0].id;
    const r = intentToAction(
      d,
      childToParentSchema.parse({
        protocol: BUILDER_PROTOCOL,
        type: 'patch-text',
        sectionId: steps.id,
        blockId: block,
        key: 'title',
        value: 'x'.repeat(500),
      })
    );
    expect(r?.action).toMatchObject({ key: 'title', value: 'x'.repeat(80) });
    expect(normalizeInlineText('x'.repeat(500), false, 10)).toHaveLength(10);
  });
});
