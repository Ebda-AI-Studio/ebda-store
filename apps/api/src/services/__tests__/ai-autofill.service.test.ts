import { describe, it, expect } from 'vitest';
import { stampHumanEdits, computeFillSet } from '../ai-autofill.service';

describe('stampHumanEdits', () => {
  it('marks a changed AI-writable field as human', () => {
    const next = stampHumanEdits({ nameAr: 'ai' }, { nameAr: 'قديم' }, { nameAr: 'جديد' });
    expect(next.nameAr).toBe('human');
  });

  it('leaves untouched fields alone', () => {
    const next = stampHumanEdits(
      { nameAr: 'ai', metaTitle: 'human' },
      { nameAr: 'x', metaTitle: 'y' },
      { nameAr: 'x', metaTitle: 'y' }
    );
    expect(next).toEqual({ nameAr: 'ai', metaTitle: 'human' });
  });

  it('clears the key when a field is emptied', () => {
    const next = stampHumanEdits({ nameAr: 'ai' }, { nameAr: 'x' }, { nameAr: '' });
    expect(next.nameAr).toBeUndefined();
  });

  it('ignores non-AI-writable fields like price', () => {
    const next = stampHumanEdits({}, { price: 1 } as any, { price: 2 } as any);
    expect(next).toEqual({});
  });

  it('treats omitted fields (PATCH) as unchanged', () => {
    const next = stampHumanEdits({ nameAr: 'ai' }, { nameAr: 'x' }, {}); // nameAr omitted
    expect(next).toEqual({ nameAr: 'ai' });
  });
});

describe('computeFillSet', () => {
  it('on create fills every empty field (both languages + SEO)', () => {
    const fields = computeFillSet({}, 'create', []);
    expect(fields.sort()).toEqual(
      [
        'name',
        'nameAr',
        'description',
        'descriptionAr',
        'metaTitle',
        'metaTitleAr',
        'metaDescription',
        'metaDescriptionAr',
      ].sort()
    );
  });

  it('on update only refreshes ai fields whose source changed (+ fills empties)', () => {
    const fields = computeFillSet({ nameAr: 'ai', descriptionAr: 'human' }, 'update', ['name']);
    expect(fields).toContain('nameAr'); // ai + source(name) changed
    expect(fields).not.toContain('descriptionAr'); // human
  });

  it('stale-refresh regenerates ai fields even with no source change, never human', () => {
    // sweep on a long-untouched product: nameAr (ai) refreshes despite no
    // changed source; metaTitle (human) is still never touched.
    const fields = computeFillSet({ nameAr: 'ai', metaTitle: 'human' }, 'sweep', [], true);
    expect(fields).toContain('nameAr');
    expect(fields).not.toContain('metaTitle');
  });

  it('without stale-refresh an ai field with no source change is left alone', () => {
    const fields = computeFillSet({ nameAr: 'ai' }, 'sweep', [], false);
    expect(fields).not.toContain('nameAr');
  });
});
