import { describe, it, expect } from 'vitest';
import {
  buildClassicManifest,
  calledEndpoints,
  topLevelKeys,
  writtenFields,
} from '../../scripts/editor-audit/classic-manifest';

describe('classic manifest parsing', () => {
  it('reads only the top-level keys of an object literal', () => {
    expect(
      topLevelKeys(`mode: 'single', typography: { fontSize: 3, x: [1, 2] }, a: f(b, c: 1)`)
    ).toEqual(['mode', 'typography', 'a']);
    expect(topLevelKeys(`title: 'a, b: c', n: 1`)).toEqual(['title', 'n']);
  });

  it('collects the fields every updateSection call writes', () => {
    const src = `
      onClick={() => updateSection('hero', s => ({ ...s, mode: 'single' }))}
      onClick={() => updateSection('hero', (s) => ({ ...s, presentation: 'framed', frame: 'none' }))}
      updateSection('categories', c => ({ ...c, showCardFrame: !c.showCardFrame }))
    `;
    expect(writtenFields(src)).toEqual({
      categories: ['showCardFrame'],
      hero: ['frame', 'mode', 'presentation'],
    });
  });

  it('collapses template parameters in endpoint paths', () => {
    expect(
      calledEndpoints(
        'apiPut(`/api/v1/stores/${storeId}/typography`, x); apiGet<A>(`/api/v1/stores/${id}/products?ids=1`)'
      )
    ).toEqual(['GET /api/v1/stores/:p/products', 'PUT /api/v1/stores/:p/typography']);
  });
});

describe('classic manifest of the real page builder', () => {
  const m = buildClassicManifest();
  it('finds the writes the page is known to make', () => {
    const keys = m.map(e => e.key);
    for (const k of [
      'hero.mode',
      'hero.presentation',
      'categories.layout',
      'newArrivals.title',
      'testimonials.minRating',
    ])
      expect(keys, k).toContain(k);
    expect(m.some(e => e.kind === 'api' && e.key === 'PUT /api/v1/stores/:p/typography')).toBe(
      true
    );
  });
  it('a field with a registry setting is wired, the compound editors included (Task 6)', () => {
    expect(m.find(e => e.key === 'hero.mode')?.status).toBe('wired');
    expect(m.find(e => e.key === 'hero.typography')?.status).toBe('wired');
    // the mobile-only legacy name is a viewport override of the registry setting
    expect(m.find(e => e.key === 'categories.layoutMobile')).toMatchObject({
      status: 'wired',
      builder: expect.stringContaining('mobile viewport override'),
    });
  });
  it('theme and typography writes are flagged as live writes (VE-4)', () => {
    expect(m.find(e => e.key === 'PUT /api/v1/stores/:p/theme')).toMatchObject({
      status: 'classic-only',
      capability: 'P-13',
    });
  });
});
