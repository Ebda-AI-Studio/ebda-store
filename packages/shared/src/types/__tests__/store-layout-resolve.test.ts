import { describe, it, expect } from 'vitest';
import { resolveLayoutSettings, DEFAULT_LAYOUT_SETTINGS } from '../store-layout';

describe('resolveLayoutSettings(input, templateId?)', () => {
  it('empty input + templateId returns that template baseline', () => {
    const r = resolveLayoutSettings({}, 'bold');
    expect(r.newArrivals.cardSize).toBe('lg');
    expect(r.categories.desktopColumns).toBe(2);
    // optional keys come from the baseline, not dropped
    expect(r.footer?.bgColor).toBe('token:primary');
    expect(r.trustStrip?.bgColor).toBe('token:card');
    expect(r.productCardDefaults?.cardSize).toBe('lg');
  });

  it('saved values win over the template baseline', () => {
    const saved = { categories: { desktopColumns: 5 }, footer: { bgColor: 'token:secondary' } };
    const r = resolveLayoutSettings(saved, 'bold');
    expect(r.categories.desktopColumns).toBe(5); // saved wins
    expect(r.footer?.bgColor).toBe('token:secondary'); // saved wins
    expect(r.newArrivals.cardSize).toBe('lg'); // unspecified → baseline
  });

  it('no templateId reproduces the legacy global-default behavior', () => {
    expect(resolveLayoutSettings({})).toEqual(DEFAULT_LAYOUT_SETTINGS);
    // legacy: optional keys absent when not saved and no template base
    expect(resolveLayoutSettings({}).footer).toBeUndefined();
  });

  it('unknown templateId falls back to the global default', () => {
    expect(resolveLayoutSettings({}, 'bogus' as never)).toEqual(DEFAULT_LAYOUT_SETTINGS);
  });
});
