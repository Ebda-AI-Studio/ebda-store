/**
 * Ruling R-EBDA-3D-2 (Ahmad 2026-10-07): 3D product models are on EVERY plan,
 * Basic included — no plan gate. And the AR hand-off helpers.
 */
import { describe, it, expect } from 'vitest';
import { FEATURE_REGISTRY, PLAN_BASELINE, STORE_PLANS, DEFAULT_PLAN_SEEDS } from '@ebda/shared';
import { arPlatform, sceneViewerIntent, showDesktopQr } from '../../packages/ui/src/model3d/ar';

describe('product_3d is in every plan', () => {
  it.each(STORE_PLANS)('baseline %s includes product_3d', plan => {
    expect(PLAN_BASELINE[plan]).toContain('product_3d');
  });
  it('every sold plan resolves to a tier that includes it (Basic, Growth, Business)', () => {
    for (const p of DEFAULT_PLAN_SEEDS) {
      expect(PLAN_BASELINE[p.featureTier], p.code).toContain('product_3d');
    }
  });
  it('is a visible, bilingual registry entry', () => {
    const f = FEATURE_REGISTRY.product_3d;
    expect(f.hidden).toBeFalsy();
    expect(f.nameAr).toMatch(/[؀-ۿ]/);
  });
});

describe('AR hand-off', () => {
  const doc = (supportsAr: boolean) =>
    ({
      createElement: () => ({ relList: { supports: (t: string) => supportsAr && t === 'ar' } }),
    }) as unknown as Document;

  it('Quick Look support wins; Android UA → scene viewer; desktop → none', () => {
    expect(arPlatform(doc(true), 'Mozilla/5.0 (iPhone)')).toBe('ios');
    expect(arPlatform(doc(false), 'Mozilla/5.0 (Linux; Android 14)')).toBe('android');
    expect(arPlatform(doc(false), 'Mozilla/5.0 (Macintosh)')).toBe('none');
    expect(arPlatform(undefined, '')).toBe('none');
  });

  it('builds a Scene Viewer intent that carries the GLB, title and fallback', () => {
    const u = sceneViewerIntent(
      'https://media.ebda.app/stores/s/models/a.glb',
      'خاتم',
      'https://shop.test/p/a'
    );
    expect(u.startsWith('intent://arvr.google.com/scene-viewer/1.0?')).toBe(true);
    expect(u).toContain('file=https%3A%2F%2Fmedia.ebda.app%2Fstores%2Fs%2Fmodels%2Fa.glb');
    expect(u).toContain('mode=ar_preferred');
    expect(u).toContain('package=com.google.android.googlequicksearchbox');
    expect(u).toContain(
      `S.browser_fallback_url=${encodeURIComponent('https://shop.test/p/a')};end;`
    );
  });
});

describe('desktop QR for View in your space (A2b)', () => {
  const base = {
    platform: 'none' as const,
    arEnabled: true,
    src: 'https://cdn.ebda.app/m.glb',
    pageUrl: 'https://shop.ebda.app/p/ring',
  };
  it('shows on a desktop when AR is on and the model is a public https file', () => {
    expect(showDesktopQr(base)).toBe(true);
  });
  it('never shows on a phone (the real AR button is there), with AR off, or for a blob: preview', () => {
    expect(showDesktopQr({ ...base, platform: 'ios' })).toBe(false);
    expect(showDesktopQr({ ...base, platform: 'android' })).toBe(false);
    expect(showDesktopQr({ ...base, arEnabled: false })).toBe(false);
    expect(showDesktopQr({ ...base, src: 'blob:https://admin/x' })).toBe(false);
    expect(showDesktopQr({ ...base, pageUrl: '' })).toBe(false);
  });
});
