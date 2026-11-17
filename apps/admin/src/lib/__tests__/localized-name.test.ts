import { describe, expect, it } from 'vitest';
import { localizedName } from '../localized-name';

describe('localizedName', () => {
  it('picks the Arabic name in ar and the English one in en', () => {
    const p = { name: 'Low Tide Ring', nameAr: 'خاتم المدّ المنخفض' };
    expect(localizedName('ar', p)).toBe('خاتم المدّ المنخفض');
    expect(localizedName('en', p)).toBe('Low Tide Ring');
  });
  it('falls back across blanks and missing entities', () => {
    expect(localizedName('ar', { name: 'Ring', nameAr: '  ' })).toBe('Ring');
    expect(localizedName('ar', { name: 'Ring', nameAr: null })).toBe('Ring');
    expect(localizedName('en', { name: '', nameAr: 'خاتم' })).toBe('خاتم');
    expect(localizedName('ar', null)).toBe('');
  });
});
