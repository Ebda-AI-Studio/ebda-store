/**
 * `validatePublishReadiness` — publish-only checks beyond structural
 * validity. A hero slide may be saved as a DRAFT with no image yet
 * (`heroSlideSchema.image` is optional, bug: "hero slide with no image
 * blocks ALL autosave") but must never reach the live storefront without
 * one. This is the gate that gives drafts that freedom back without letting
 * an incomplete slide publish.
 */
import { describe, it, expect } from 'vitest';
import {
  layoutToDefinition,
  resolveLayoutSettings,
  reduceDocument,
  validateDefinitionSync,
  validatePublishReadiness,
  type PageDefinition,
} from '@ebda/shared';
import { loadLayoutFixture } from '../fixtures/builder/homepage-data';

const base = (): PageDefinition =>
  layoutToDefinition(resolveLayoutSettings(loadLayoutFixture('pecannbee-flow'), 'modern'));

const addImagelessSlide = (doc: PageDefinition): PageDefinition => {
  const r = reduceDocument(doc, { type: 'addBlock', sectionId: 'hero', blockType: 'slide' });
  if (r.rejected) throw new Error(`addBlock rejected: ${r.rejected}`);
  return r.doc;
};

describe('validatePublishReadiness', () => {
  it('passes a document whose hero has no incomplete slides', () => {
    expect(validatePublishReadiness(base())).toEqual([]);
  });

  it('still passes validateDefinitionSync (structural shape) for a slide with no image — drafts may be incomplete', () => {
    const doc = addImagelessSlide(base());
    expect(validateDefinitionSync(doc).ok).toBe(true);
  });

  it('flags a visible hero slide with no image as MISSING_IMAGE', () => {
    const doc = addImagelessSlide(base());
    const errors = validatePublishReadiness(doc);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('MISSING_IMAGE');
    expect(errors[0].path).toMatch(/\/sections\/\d+\/blocks\/\d+\/settings\/image/);
  });

  it('does NOT flag an imageless slide on a HIDDEN hero section', () => {
    const doc = addImagelessSlide(base());
    const hidden: PageDefinition = {
      ...doc,
      sections: doc.sections.map(s => (s.type === 'hero' ? { ...s, hidden: true } : s)),
    };
    expect(validatePublishReadiness(hidden)).toEqual([]);
  });

  it('does NOT flag an imageless slide that is itself hidden', () => {
    const doc = addImagelessSlide(base());
    const hidden: PageDefinition = {
      ...doc,
      sections: doc.sections.map(s =>
        s.type === 'hero'
          ? { ...s, blocks: (s.blocks ?? []).map(b => ({ ...b, hidden: true })) }
          : s
      ),
    };
    expect(validatePublishReadiness(hidden)).toEqual([]);
  });

  it('clears once the slide is given an image', () => {
    const doc = addImagelessSlide(base());
    const fixed: PageDefinition = {
      ...doc,
      sections: doc.sections.map(s =>
        s.type === 'hero'
          ? {
              ...s,
              blocks: (s.blocks ?? []).map(b => ({
                ...b,
                settings: { ...b.settings, image: '/new-slide.jpg' },
              })),
            }
          : s
      ),
    };
    expect(validatePublishReadiness(fixed)).toEqual([]);
  });
});
