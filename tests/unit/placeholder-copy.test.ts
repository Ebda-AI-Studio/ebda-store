/**
 * `isPlaceholderCopy` — the single placeholder predicate shared by the
 * editor publish gate (`validatePublishReadiness`) and the bulk AI write
 * guard. Whole-string matching: real merchant copy that merely CONTAINS a
 * placeholder-looking word must never trip it.
 */
import { describe, it, expect } from 'vitest';
import {
  PLACEHOLDER_STARTER_COPY,
  getSectionDefinition,
  isPlaceholderCopy,
  layoutToDefinition,
  reduceDocument,
  resolveLayoutSettings,
  validatePublishReadiness,
  type PageDefinition,
} from '@force/shared';
import { isPlaceholderText } from '../../apps/api/src/lib/ai/placeholder-guard';

describe('isPlaceholderCopy: true positives', () => {
  it.each([
    'N/A',
    'n/a',
    'TBD',
    'todo',
    'undefined',
    'null',
    '...',
    '-----',
    '[insert text here]',
    '{{heading}}',
    'Lorem ipsum dolor sit amet',
    'lorem ipsum',
    'Sample text',
    'Placeholder',
    'Your text here',
    'Write your story here.',
    'Insert heading here',
    PLACEHOLDER_STARTER_COPY.imageTextBody.en,
    PLACEHOLDER_STARTER_COPY.imageTextBody.ar,
    '  Tell customers what makes your products special  ',
    'لوريم إيبسوم هو نموذج',
    'نص تجريبي',
    'نص نموذجي',
    'اكتب النص هنا',
    'أضف عنوانك هنا',
  ])('flags %j', v => {
    expect(isPlaceholderCopy(v)).toBe(true);
  });
});

describe('isPlaceholderCopy: legitimate merchant copy must NOT trip', () => {
  it.each([
    'Handmade candles poured in small batches in Cairo.',
    'Returns: n/a for sale items',
    'Todo lo que necesitas',
    'Nullable Studio',
    'Test kitchen favourites',
    'Shop here and save',
    'Our story',
    'Made by hand',
    '50% off - today only',
    'شموع يدوية بنصبّها على دفعات صغيرة في القاهرة.',
    'تسوق هنا واستلم طلبك في ٣ أيام',
    'نص الشعار الرسمي لمتجرنا',
    'حكايتنا',
    '',
    '   ',
  ])('passes %j', v => {
    expect(isPlaceholderCopy(v)).toBe(false);
  });

  it('non-strings are not placeholder COPY (they are just not text)', () => {
    expect(isPlaceholderCopy(undefined)).toBe(false);
    expect(isPlaceholderCopy(42)).toBe(false);
    expect(isPlaceholderCopy(null)).toBe(false);
  });
});

describe('AI write guard keeps its stricter contract', () => {
  it('blank / non-string AI output is still unacceptable there', () => {
    expect(isPlaceholderText('')).toBe(true);
    expect(isPlaceholderText(undefined)).toBe(true);
    expect(isPlaceholderText('N/A')).toBe(true);
    expect(isPlaceholderText('Delivery takes 2-4 business days across Cairo and Giza.')).toBe(
      false
    );
  });
});

describe('registry presets source their starter copy from the one constant', () => {
  it('image-text preset 0 body is exactly the refused starter copy (no drift)', () => {
    const p = getSectionDefinition('image-text')!.presets[0].settings;
    expect(p.body).toBe(PLACEHOLDER_STARTER_COPY.imageTextBody.en);
    expect(p.bodyAr).toBe(PLACEHOLDER_STARTER_COPY.imageTextBody.ar);
  });

  it('no OTHER registry preset ships text the publish gate refuses', () => {
    // Only image-text preset 0 is allowed to carry starter copy; every other
    // preset must be publishable as inserted (it is real, generic copy).
    const bad: string[] = [];
    for (const type of ['newsletter', 'featured-collection', 'collection-list', 'trust-badges']) {
      const d = getSectionDefinition(type);
      d?.presets.forEach((pr, i) => {
        for (const v of Object.values(pr.settings))
          if (isPlaceholderCopy(v)) bad.push(`${type}#${i}`);
      });
    }
    expect(bad).toEqual([]);
  });
});

describe('validatePublishReadiness: PLACEHOLDER_COPY', () => {
  const base = (): PageDefinition => layoutToDefinition(resolveLayoutSettings({}, 'modern'));
  const withStarter = (): PageDefinition =>
    reduceDocument(base(), {
      type: 'addSection',
      list: 'template',
      sectionType: 'image-text',
      presetIndex: 0,
    }).doc;

  it('a clean default document is publish-ready', () => {
    expect(validatePublishReadiness(base())).toEqual([]);
  });

  it('flags the starter body in BOTH languages, naming the section, with a pointer path', () => {
    const errors = validatePublishReadiness(withStarter());
    const ph = errors.filter(e => e.code === 'PLACEHOLDER_COPY');
    expect(ph.map(e => e.path.split('/').pop()).sort()).toEqual(['body', 'bodyAr']);
    expect(ph[0].path).toMatch(/^\/sections\/\d+\/settings\//);
    expect(ph[0].messageEn).toContain('Image with text');
    expect(ph[0].messageAr).toContain('صورة مع نص');
  });

  it('flags only the language that still holds placeholder text', () => {
    const doc = withStarter();
    const fixedAr: PageDefinition = {
      ...doc,
      sections: doc.sections.map(n =>
        n.type === 'image-text'
          ? { ...n, settings: { ...n.settings, bodyAr: 'شموع يدوية من القاهرة.' } }
          : n
      ),
    };
    const ph = validatePublishReadiness(fixedAr).filter(e => e.code === 'PLACEHOLDER_COPY');
    expect(ph).toHaveLength(1);
    expect(ph[0].path.endsWith('/body')).toBe(true);
  });

  it('does not flag a hidden section', () => {
    const doc = withStarter();
    const hidden: PageDefinition = {
      ...doc,
      sections: doc.sections.map(n => (n.type === 'image-text' ? { ...n, hidden: true } : n)),
    };
    expect(validatePublishReadiness(hidden)).toEqual([]);
  });

  it('placeholderCopy:false skips the copy scan (legacy layout PUT) but keeps the image check', () => {
    expect(validatePublishReadiness(withStarter(), { placeholderCopy: false })).toEqual([]);
  });

  it('ignores non-text settings (an id/url/colour that looks like a placeholder is not copy)', () => {
    const doc = withStarter();
    const odd: PageDefinition = {
      ...doc,
      sections: doc.sections.map(n =>
        n.type === 'image-text'
          ? {
              ...n,
              settings: {
                ...n.settings,
                body: 'Real body copy.',
                bodyAr: 'نص حقيقي.',
                imagePosition: 'start',
                buttonLink: '...',
              },
            }
          : n
      ),
    };
    expect(validatePublishReadiness(odd)).toEqual([]);
  });
});
