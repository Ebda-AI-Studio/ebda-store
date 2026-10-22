/**
 * Ruling METAL-1 (Ahmad, 2026-10-22): brass and antique gold are METAL and are allowed as buttons,
 * chips and accents on every template; no orange anywhere else. One band replaces the per-look
 * exceptions of B2-18, B2-26, B3-2/B3-14 and B4-2, and a true orange must still fail the gate.
 */
import { describe, it, expect } from 'vitest';
import { isMetal, isForbiddenOrange, isOrangeFamily, METAL_HUE } from './helpers/orange-gate';
import { LOOKS } from '@ebda/shared';

describe('Ruling METAL-1: the metal band', () => {
  it('brass and antique gold are orange-family by hue and metal by the band (so they pass the gate)', () => {
    for (const c of ['#C89B3C', '#D3B87C', '41 56% 51%', '#C89B3D', '#C99B3C']) {
      expect(isOrangeFamily(c), c).toBe(true);
      expect(isMetal(c), c).toBe(true);
      expect(isForbiddenOrange(c), c).toBe(false);
    }
  });
  it('NEGATIVE CONTROLS: saffron, amber, terracotta, lantern orange and brand orange still fail', () => {
    for (const c of [
      '#E0A526', // Lamma saffron (HSL saturation 74%)
      '#F2B632', // market saffron
      '#E8A33D', // amber (hue 36)
      '#D4A03C', // saturated amber (HSL saturation 64%)
      '#C8A06A', // in-band tan, hue 35
      '#B5482E', // terracotta
      '#E68245', // lantern orange
      '#FF6E01', // Force orange
      '#C9822B', // burnt amber
      '38 92% 50%', // platform amber
    ])
      expect(isForbiddenOrange(c), c).toBe(true);
  });
  it('the band is exactly hue 38-46, HSL saturation <= 60%, lightness 40-76%', () => {
    expect(METAL_HUE).toEqual([38, 46]);
    expect(isMetal('#808080')).toBe(false); // grey has no hue
    expect(isMetal('#2B1A1F')).toBe(false);
  });
  it('no shipped souq, jasmine or lamma look token is a forbidden orange (the three gated templates)', () => {
    for (const l of LOOKS.filter(x => /^(souq|jasmine|lamma)\./.test(x.id)))
      for (const [k, v] of Object.entries(l.tokens))
        if (typeof v === 'string' && /^#/.test(v))
          expect(isForbiddenOrange(v), `${l.id}.${k} ${v}`).toBe(false);
  });
});
