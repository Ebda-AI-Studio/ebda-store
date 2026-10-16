import { describe, it, expect } from 'vitest';
import { AI_AUTOFILL_FIELDS, fieldsNeedingRefresh, type FieldSource } from '../ai-autofill';

describe('AI autofill registry', () => {
  it('lists the bidirectional en/ar pairs and SEO fields in order', () => {
    const names = AI_AUTOFILL_FIELDS.map(f => f.field);
    expect(names).toEqual([
      'name',
      'nameAr',
      'description',
      'descriptionAr',
      'metaTitle',
      'metaTitleAr',
      'metaDescription',
      'metaDescriptionAr',
      'searchTerms',
    ]);
  });

  it('refreshes ai fields whose source changed and fills empty fields; never human', () => {
    // English `name` changed. nameAr is ai + sources name → refreshes. name is
    // human (the merchant typed it) → never. All other fields are empty → fill.
    const sources: Record<string, FieldSource> = { nameAr: 'ai', name: 'human' };
    const result = fieldsNeedingRefresh(sources, ['name']);
    expect(result.sort()).toEqual(
      [
        'descriptionAr',
        'description',
        'metaDescription',
        'metaDescriptionAr',
        'metaTitle',
        'metaTitleAr',
        'nameAr',
        'searchTerms',
      ].sort()
    );
    expect(result).not.toContain('name'); // human
  });

  it('refreshes from a change in EITHER language (bidirectional, Arabic-first)', () => {
    // Merchant edits the ARABIC name. nameAr is human (just edited) → never.
    // name is ai-owned and sources nameAr → refreshes (AR→EN). metaTitle is
    // ai-owned and sources nameAr → refreshes.
    const sources: Record<string, FieldSource> = { name: 'ai', nameAr: 'human', metaTitle: 'ai' };
    const result = fieldsNeedingRefresh(sources, ['nameAr']);
    expect(result).toContain('name');
    expect(result).toContain('metaTitle');
    expect(result).not.toContain('nameAr'); // human — never touched
  });

  it('on create (empty changedFields) fills every empty non-human field', () => {
    // CREATE path: changedFields is []. Every empty field fills; a human-owned
    // field is left alone even on create.
    const result = fieldsNeedingRefresh({ name: 'human' }, []);
    expect(result.sort()).toEqual(
      [
        'descriptionAr',
        'description',
        'metaDescription',
        'metaDescriptionAr',
        'metaTitle',
        'metaTitleAr',
        'nameAr',
        'searchTerms',
      ].sort()
    );
    expect(result).not.toContain('name');
  });

  it('leaves an ai field untouched when its source did not change', () => {
    // nameAr is ai-owned, only `price` changed (not a source) → no refresh.
    const result = fieldsNeedingRefresh({ nameAr: 'ai' }, ['price']);
    expect(result).not.toContain('nameAr');
  });

  it('searchTerms refreshes when either language name or description changes, never when human', () => {
    expect(fieldsNeedingRefresh({ searchTerms: 'ai' }, ['nameAr'])).toContain('searchTerms');
    expect(fieldsNeedingRefresh({ searchTerms: 'human' }, ['nameAr'])).not.toContain('searchTerms');
    for (const src of ['name', 'nameAr', 'description', 'descriptionAr']) {
      expect(fieldsNeedingRefresh({ searchTerms: 'ai' }, [src])).toContain('searchTerms');
    }
    // A merchant editing only the price leaves AI search words alone.
    expect(fieldsNeedingRefresh({ searchTerms: 'ai' }, ['price'])).not.toContain('searchTerms');
  });
});
