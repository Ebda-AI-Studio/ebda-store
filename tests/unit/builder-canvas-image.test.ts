/**
 * Task 3: which pictures the canvas may ask to replace, and what the parent
 * does with the answer. The child never sends a URL (VE-2).
 */
import { describe, it, expect } from 'vitest';
import {
  BUILDER_PROTOCOL,
  childToParentSchema,
  imageSwapActions,
  layoutToDefinition,
  mediaRequestFor,
  reduceDocument,
  resolveLayoutSettings,
  type PageDefinition,
} from '@ebda/shared';
import { displayedImageKey } from '../../apps/web/src/builder/render/image-key';

const doc = (): PageDefinition =>
  layoutToDefinition(
    resolveLayoutSettings(
      {
        hero: {
          enabled: true,
          slides: [{ image: '/a.jpg', alt: 'old alt' }, { image: '/b.jpg' }],
        },
      } as never,
      'modern'
    )
  );
const heroId = (d: PageDefinition) => d.sections.find(n => n.type === 'hero')!.id;
const ask = (m: Record<string, unknown>) =>
  childToParentSchema.parse({ protocol: BUILDER_PROTOCOL, type: 'request-media', ...m });

describe('mediaRequestFor', () => {
  it('accepts an image setting of a real block and reports its size standard and alt', () => {
    const d = doc();
    const r = mediaRequestFor(d, ask({ sectionId: heroId(d), blockId: 'slide-1', key: 'image' }));
    expect(r?.target.standard).toBe('heroDesktop');
    expect(r?.alt).toEqual({ en: 'old alt' });
    const mobile = mediaRequestFor(
      d,
      ask({ sectionId: heroId(d), blockId: 'slide-1', key: 'imageMobile' })
    );
    expect(mobile?.target.standard).toBe('heroMobile');
    // a mobile variant shares the main picture's alt, so it asks for none
    expect(mobile?.alt).toBeUndefined();
  });

  it('drops a key that is not an image setting, an unknown id and a section/block mix-up', () => {
    const d = doc();
    const id = heroId(d);
    expect(
      mediaRequestFor(d, ask({ sectionId: id, blockId: 'slide-1', key: 'headline' }))
    ).toBeNull();
    expect(mediaRequestFor(d, ask({ sectionId: id, blockId: 'slide-1', key: 'nope' }))).toBeNull();
    expect(mediaRequestFor(d, ask({ sectionId: id, blockId: 'slide-9', key: 'image' }))).toBeNull();
    expect(mediaRequestFor(d, ask({ sectionId: 'ghost', key: 'image' }))).toBeNull();
    // `image` is a block setting of a hero slide, not a setting of the hero section
    expect(mediaRequestFor(d, ask({ sectionId: id, key: 'image' }))).toBeNull();
  });

  it('ignores every other message type', () => {
    const d = doc();
    expect(
      mediaRequestFor(d, childToParentSchema.parse({ protocol: BUILDER_PROTOCOL, type: 'ready' }))
    ).toBeNull();
  });
});

describe('imageSwapActions', () => {
  it('sets the picture and the description with ONE coalesce key (one undo step)', () => {
    const d = doc();
    const req = mediaRequestFor(
      d,
      ask({ sectionId: heroId(d), blockId: 'slide-2', key: 'image' })
    )!;
    const acts = imageSwapActions(req, 'https://media.ebda.app/x.jpg', { en: ' A box ' });
    expect(acts.map(a => a.action)).toEqual([
      {
        type: 'setBlockSetting',
        sectionId: heroId(d),
        blockId: 'slide-2',
        key: 'image',
        value: 'https://media.ebda.app/x.jpg',
      },
      {
        type: 'setBlockSetting',
        sectionId: heroId(d),
        blockId: 'slide-2',
        key: 'alt',
        value: 'A box',
      },
    ]);
    expect(new Set(acts.map(a => a.coalesce)).size).toBe(1);
    let out = d;
    for (const a of acts) out = reduceDocument(out, a.action).doc;
    const slide = out.sections
      .find(n => n.id === heroId(d))!
      .blocks!.find(b => b.id === 'slide-2')!;
    expect(slide.settings).toMatchObject({ image: 'https://media.ebda.app/x.jpg', alt: 'A box' });
  });

  it('writes no alt when the setting has none, or none was given', () => {
    const d = doc();
    const mobile = mediaRequestFor(
      d,
      ask({ sectionId: heroId(d), blockId: 'slide-1', key: 'imageMobile' })
    )!;
    expect(imageSwapActions(mobile, 'u', { en: 'ignored' })).toHaveLength(1);
    const main = mediaRequestFor(
      d,
      ask({ sectionId: heroId(d), blockId: 'slide-1', key: 'image' })
    )!;
    expect(imageSwapActions(main, 'u')).toHaveLength(1);
  });
});

describe('displayedImageKey', () => {
  it('names the setting that is on screen', () => {
    expect(displayedImageKey(true, '/en.jpg', '/ar.jpg')).toBe('imageAr');
    expect(displayedImageKey(true, '/en.jpg', undefined)).toBe('image');
    expect(displayedImageKey(false, '/en.jpg', '/ar.jpg')).toBe('image');
    expect(displayedImageKey(false, undefined, '/ar.jpg')).toBe('imageAr');
    expect(displayedImageKey(true, undefined, undefined)).toBe('image');
  });
});
