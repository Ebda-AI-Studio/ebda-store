import { describe, it, expect } from 'vitest';
import { resolveLayoutSettings, DEFAULT_LAYOUT_SETTINGS } from '../store-layout';
import { RETIRED_TEMPLATES } from '../../templates/legacy-skin-map';

describe('resolveLayoutSettings(input, templateId?)', () => {
  it('empty input + templateId returns that template baseline', () => {
    const r = resolveLayoutSettings({}, 'qamar');
    expect(r.newArrivals.cardSize).toBe('sm');
    expect(r.categories.desktopColumns).toBe(4);
    // optional keys come from the baseline, not dropped
    expect(r.trustStrip?.bgColor).toBe('token:card');
    expect(r.productCardDefaults?.cardSize).toBe('sm');
  });

  it('saved values win over the template baseline', () => {
    const saved = { categories: { desktopColumns: 5 }, footer: { bgColor: 'token:secondary' } };
    const r = resolveLayoutSettings(saved, 'qamar');
    expect(r.categories.desktopColumns).toBe(5); // saved wins
    expect(r.footer?.bgColor).toBe('token:secondary'); // saved wins
    expect(r.newArrivals.cardSize).toBe('sm'); // unspecified → baseline
  });

  it('no templateId reproduces the legacy global-default behavior', () => {
    expect(resolveLayoutSettings({})).toEqual(DEFAULT_LAYOUT_SETTINGS);
    // legacy: optional keys absent when not saved and no template base
    expect(resolveLayoutSettings({}).footer).toBeUndefined();
  });

  it('a retired Force skin name resolves as its mapped Ebda template (SKIN-DEL-1)', () => {
    expect(resolveLayoutSettings({}, RETIRED_TEMPLATES[3] as never)).toEqual(
      resolveLayoutSettings({}, 'qamar')
    );
  });

  it('unknown templateId falls back to the global default', () => {
    expect(resolveLayoutSettings({}, 'bogus' as never)).toEqual(DEFAULT_LAYOUT_SETTINGS);
  });
});
