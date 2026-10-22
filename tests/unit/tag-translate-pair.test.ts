/**
 * A legacy tag keeps its Arabic text in `name`. "Translate missing" must read it as Arabic
 * (ar -> en), never as English, and keep the Arabic as `nameAr` when the English comes back.
 */
import { describe, expect, it, vi } from 'vitest';
import { isArabicScript, tagTranslatePair } from '../../apps/admin/src/lib/tag-translate-pair';

describe('isArabicScript', () => {
  it('detects Arabic, rejects Latin and mixed', () => {
    expect(isArabicScript('بشرة دهنية')).toBe(true);
    expect(isArabicScript('Oily skin')).toBe(false);
    expect(isArabicScript('سيروم Vitamin C')).toBe(false);
    expect(isArabicScript('')).toBe(false);
    expect(isArabicScript('123')).toBe(false);
  });
});

describe('tagTranslatePair', () => {
  it('legacy Arabic name: sends it as the Arabic side and moves it to nameAr on the English answer', () => {
    const patch = vi.fn();
    const p = tagTranslatePair({ id: 't1', name: 'بشرة دهنية', nameAr: '' }, patch);
    expect(p.en).toBe('');
    expect(p.ar).toBe('بشرة دهنية');
    p.onEnFilled('Oily skin');
    expect(patch).toHaveBeenCalledWith('t1', { name: 'Oily skin', nameAr: 'بشرة دهنية' });
  });
  it('English name, no Arabic: translated en -> ar as before', () => {
    const patch = vi.fn();
    const p = tagTranslatePair({ id: 't2', name: 'Oily skin', nameAr: '' }, patch);
    expect(p.en).toBe('Oily skin');
    expect(p.ar).toBe('');
    p.onArFilled('بشرة دهنية');
    expect(patch).toHaveBeenCalledWith('t2', { nameAr: 'بشرة دهنية' });
  });
  it('an Arabic name WITH an Arabic label already is left alone', () => {
    const p = tagTranslatePair({ id: 't3', name: 'بشرة', nameAr: 'بشرة' }, vi.fn());
    expect(p.en).toBe('بشرة');
    expect(p.ar).toBe('بشرة');
  });
});
