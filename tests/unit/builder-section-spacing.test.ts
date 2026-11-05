/**
 * Per-section, per-device spacing (editor Ruling SP-1): the adapter carries the four device keys
 * through `responsive.<vp>.settings`, a desktop-only document is untouched, the registry declares
 * the keys, and the resolution order is device -> base -> preset -> baseline.
 */
import { describe, it, expect } from 'vitest';
import {
  SECTION_REGISTRY,
  SECTION_SPACING_PX,
  SECTION_SPACING_PRESETS,
  definitionToLayout,
  getSectionDefinition,
  hasDeviceSpacing,
  layoutToDefinition,
  resolveLayoutSettings,
  resolveSpacingPreset,
  resolveSpacingPx,
  validateDefinitionSync,
  type StoreLayoutSettings,
} from '@ebda/shared';

const layoutWith = (patch: Record<string, unknown>): StoreLayoutSettings =>
  resolveLayoutSettings({ newArrivals: { enabled: true, ...patch } });

describe('adapter: per-device spacing', () => {
  it('maps the flat device keys to responsive.<vp>.settings and back (round trip)', () => {
    const L = layoutWith({
      paddingTop: 'loose',
      paddingTopTablet: 'normal',
      paddingTopMobile: 'tight',
      paddingBottomMobile: 'none',
    });
    const def = layoutToDefinition(L);
    const node = def.sections.find(n => n.type === 'new-arrivals' || n.id.includes('new'));
    expect(node?.settings).toMatchObject({ paddingTop: 'loose' });
    expect(node?.settings).not.toHaveProperty('paddingTopMobile');
    expect(node?.responsive?.tablet?.settings).toEqual({ paddingTop: 'normal' });
    expect(node?.responsive?.mobile?.settings).toEqual({
      paddingTop: 'tight',
      paddingBottom: 'none',
    });
    expect(definitionToLayout(def)).toEqual(L);
    expect(layoutToDefinition(definitionToLayout(def))).toEqual(def);
  });

  it('a desktop-only layout produces no responsive block (byte-identical document)', () => {
    const L = layoutWith({ paddingTop: 'xloose', paddingBottom: 'tight' });
    const node = layoutToDefinition(L).sections.find(n => n.settings.paddingTop === 'xloose');
    expect(node?.responsive).toBeUndefined();
    expect(JSON.stringify(definitionToLayout(layoutToDefinition(L)))).toBe(JSON.stringify(L));
  });

  it('works on the hero and on header / footer too', () => {
    const L = resolveLayoutSettings({
      hero: { enabled: true, paddingTopMobile: 'tight' },
      footer: { paddingBottomTablet: 'loose' },
    });
    const def = layoutToDefinition(L);
    expect(def.sections.find(n => n.type === 'hero')?.responsive?.mobile?.settings).toEqual({
      paddingTop: 'tight',
    });
    expect(def.sectionGroups.footer[0]?.responsive?.tablet?.settings).toEqual({
      paddingBottom: 'loose',
    });
    expect(definitionToLayout(def)).toEqual(L);
  });
});

describe('registry + validation', () => {
  it('every section with Top / Bottom spacing declares tablet + mobile responsive keys', () => {
    for (const d of SECTION_REGISTRY) {
      const has = d.settings.some(s => s.id === 'paddingTop');
      for (const v of ['tablet', 'mobile'] as const) {
        const keys = d.responsive.settings[v] ?? [];
        expect(keys.includes('paddingTop'), `${d.type} ${v} top`).toBe(has);
        expect(keys.includes('paddingBottom'), `${d.type} ${v} bottom`).toBe(has);
      }
    }
  });

  it('the hero now offers Top / Bottom spacing (not Width)', () => {
    const ids = getSectionDefinition('hero')!.settings.map(s => s.id);
    expect(ids).toContain('paddingTop');
    expect(ids).toContain('paddingBottom');
    expect(ids).not.toContain('maxWidth');
  });

  it('every spacing select offers the six steps in order, ending in xxloose', () => {
    const top = getSectionDefinition('product-carousel')!.settings.find(
      s => s.id === 'paddingTop'
    )!;
    expect(top.options?.map(o => o.value)).toEqual([...SECTION_SPACING_PRESETS]);
    expect(top.options?.[5].labelAr).toBe('ضخم');
  });

  it('validate accepts a per-device value and rejects an unsupported key / value', () => {
    const L = layoutWith({ paddingTop: 'normal', paddingTopMobile: 'xxloose' });
    const def = layoutToDefinition(L);
    expect(validateDefinitionSync(def).ok).toBe(true);
    const bad = structuredClone(def);
    const n = bad.sections.find(x => x.responsive?.mobile?.settings)!;
    n.responsive!.mobile!.settings = { paddingTop: 'gigantic' };
    expect(validateDefinitionSync(bad).ok).toBe(false);
    const wrongKey = structuredClone(def);
    const m = wrongKey.sections.find(x => x.responsive?.mobile?.settings)!;
    m.responsive!.mobile!.settings = { maxWidth: 'full' };
    expect(validateDefinitionSync(wrongKey).ok).toBe(false);
  });
});

describe('resolution order: device -> base -> preset -> baseline', () => {
  it('device value wins', () => {
    expect(
      resolveSpacingPreset({ paddingTop: 'loose', paddingTopMobile: 'tight' }, 'Top', 'mobile')
    ).toBe('tight');
  });
  it('falls to the base value when the device has none', () => {
    expect(resolveSpacingPreset({ paddingTop: 'loose' }, 'Top', 'tablet')).toBe('loose');
    expect(
      resolveSpacingPreset({ paddingTop: 'loose', paddingTopMobile: 'tight' }, 'Top', 'desktop')
    ).toBe('loose');
  });
  it('is undefined when nothing is set; px then use the baseline preset column', () => {
    expect(resolveSpacingPreset({}, 'Bottom', 'mobile')).toBeUndefined();
    expect(resolveSpacingPx({}, 'Bottom', 'mobile')).toBe(48);
    expect(resolveSpacingPx({}, 'Bottom', 'desktop')).toBe(80);
  });
  it('axes are independent', () => {
    const v = { paddingTop: 'none', paddingBottomMobile: 'xxloose' };
    expect(resolveSpacingPx(v, 'Top', 'mobile')).toBe(0);
    expect(resolveSpacingPx(v, 'Bottom', 'mobile')).toBe(SECTION_SPACING_PX.xxloose.mobile);
    expect(resolveSpacingPx(v, 'Bottom', 'desktop')).toBe(80);
  });
  it('hasDeviceSpacing is true only with a tablet / mobile value', () => {
    expect(hasDeviceSpacing({ paddingTop: 'loose' })).toBe(false);
    expect(hasDeviceSpacing({ paddingBottomTablet: 'tight' })).toBe(true);
  });
  it('the px table grows with the preset on every device', () => {
    for (const v of ['mobile', 'tablet', 'desktop'] as const) {
      const px = SECTION_SPACING_PRESETS.map(p => SECTION_SPACING_PX[p][v]);
      expect([...px].sort((a, b) => a - b)).toEqual(px);
    }
  });
});
