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

  it('stamps human when a field is emptied — a clear is an edit', () => {
    // Dropping the key here made the field look like an empty gap, so the
    // autopilot (fired by product.upserted on the same save) re-translated it
    // from the sibling language and the merchant's clear reappeared.
    const next = stampHumanEdits({ nameAr: 'ai' }, { nameAr: 'x' }, { nameAr: '' });
    expect(next.nameAr).toBe('human');
  });

  it('stamps human when a field is cleared with null (the PUT clear path)', () => {
    const next = stampHumanEdits(
      { description: 'ai' },
      { description: 'An English description', descriptionAr: 'وصف عربي' },
      { description: null }
    );
    expect(next.description).toBe('human');
  });

  it('leaves an already-empty field fillable through whitespace churn', () => {
    // '' → '  ' on create is not a merchant clear; the field must stay a gap.
    const next = stampHumanEdits({}, { nameAr: '' }, { nameAr: '  ' });
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

describe('stampHumanEdits — search words (search program P1)', () => {
  it('a merchant edit of AI search words makes them human (the AI never rewrites them)', () => {
    const next = stampHumanEdits(
      { searchTerms: 'ai' },
      { searchTerms: 'جزمه, gazma' },
      { searchTerms: 'جزمه, gazma, kotshy' }
    );
    expect(next.searchTerms).toBe('human');
  });

  it('re-saving the same AI words keeps them AI-owned', () => {
    const next = stampHumanEdits(
      { searchTerms: 'ai' },
      { searchTerms: 'جزمه, gazma' },
      { searchTerms: 'جزمه, gazma' }
    );
    expect(next.searchTerms).toBe('ai');
  });
});

describe('computeFillSet', () => {
  it('on create fills every empty field (both languages + SEO + search words)', () => {
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
        'searchTerms',
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

  it('never re-fills a field the merchant just cleared (end-to-end of the two helpers)', () => {
    // Bilingual product: merchant empties the English description, Arabic stays.
    const sources = stampHumanEdits(
      { description: 'ai', descriptionAr: 'human' },
      { description: 'Old English copy', descriptionAr: 'وصف عربي' },
      { description: null }
    );
    // The autopilot's own fill set, computed from that provenance map.
    expect(computeFillSet(sources, 'update', ['description'])).not.toContain('description');
    // Even the stale-refresh sweep leaves it alone.
    expect(computeFillSet(sources, 'sweep', [], true)).not.toContain('description');
  });
});
