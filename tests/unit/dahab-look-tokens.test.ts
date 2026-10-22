// Phase B5 Task 1: the three Dahab looks' tokens (Ruling B5-2) and the no-orange gate with the one
// metal rule (Ruling METAL-1). The designed palettes failed the gate (Worn/Gift box brass accents,
// Workshop coral CTA 2.91:1 on its own page); they are re-derived to rose gold, silver, enamel and
// champagne. The gate has negative controls: it must flag the old coral and the old brass accents.
import { describe, it, expect } from 'vitest';
import {
  LOOKS,
  contrastRatio,
  composeStoreTheme,
  deriveBrandRoles,
  hexToHsl,
  TEMPLATE_THEMES,
  TEMPLATE_LAYOUT_BASELINES,
  themeToCssVars,
} from '@ebda/shared';
import { isOrangeFamily, isForbiddenOrange, isMetal } from './helpers/orange-gate';

const dahab = LOOKS.filter(l => l.template === 'dahab');
const triplet = /^-?[\d.]+\s+[\d.]+%\s+[\d.]+%$/;
const by = (id: string) => dahab.find(l => l.id === id)!.tokens;

describe('no-orange gate has teeth on the old Dahab palettes (negative control)', () => {
  it('flags both old brass accents (hue 36 and 38 below the metal lightness floor)', () => {
    for (const c of ['#9A6E2A', '#7E5E27']) {
      expect(isOrangeFamily(c), c).toBe(true);
      expect(isMetal(c), c).toBe(false);
      expect(isForbiddenOrange(c), c).toBe(true);
    }
  });
  it('the old coral CTA sits at hue 11, one degree under the band, so the HUE gate cannot flag it: the contrast bar does (measured 2.91:1 on the Workshop page)', () => {
    expect(isOrangeFamily('#E2674A')).toBe(false);
    expect(contrastRatio('#0F4C4A', '#E2674A')).toBeLessThan(3);
  });
  it('passes the metals the re-derived looks use', () => {
    for (const c of ['#8F4F59', '#E4E7EB', '#9FD8CB', '#D8C9A8', '#E8606A'])
      expect(isForbiddenOrange(c), c).toBe(false);
  });
});

describe('dahab looks: shape', () => {
  it('there are exactly three, on the dahab skin', () => {
    expect(dahab.map(l => l.id).sort()).toEqual(['dahab.giftbox', 'dahab.workshop', 'dahab.worn']);
    for (const l of dahab) {
      expect(l.skin, l.id).toBe('dahab');
      expect(['designed', 'built']).toContain(l.status);
    }
  });
  it('the tokens are exactly the re-derived ones of Ruling B5-2', () => {
    const w = by('dahab.worn');
    expect([w.page, w.surface, w.ink, w.primary, w.accent]).toEqual([
      '#FFFFFF',
      '#F6F6F6',
      '#121212',
      '#121212',
      '#8F4F59',
    ]);
    const k = by('dahab.workshop');
    expect([k.page, k.surface, k.ink, k.primary, k.onPrimary, k.accent, k.line]).toEqual([
      '#0F4C4A',
      '#135957',
      '#FFFFFF',
      '#E4E7EB',
      '#0F4C4A',
      '#9FD8CB',
      '#D8C9A8',
    ]);
    const g = by('dahab.giftbox');
    expect([g.page, g.surface, g.ink, g.primary, g.accent]).toEqual([
      '#FFFFFF',
      '#F2C9C4',
      '#16201C',
      '#0E5C46',
      '#8F4F59',
    ]);
  });
});

describe('dahab looks: painted text pairs >= 4.5, UI pairs >= 3', () => {
  for (const l of dahab) {
    const t = l.tokens;
    it.each([
      ['ink on page', t.page, t.ink],
      ['ink on surface', t.surface, t.ink],
      ['muted on page', t.page, t.muted],
      ['muted on surface', t.surface, t.muted],
      ['onPrimary on primary', t.primary, t.onPrimary],
      ['onAccent (or onPrimary) on accent', t.accent, t.onAccent ?? t.onPrimary],
    ])(`${l.id}: %s >= 4.5`, (_n, bg, fg) => {
      expect(contrastRatio(bg, fg)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${l.id}: primary reads as text and as a boundary on the page`, () => {
      expect(contrastRatio(t.page, t.primary)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${l.id}: accent reads as text on the page and as a UI mark on the surface`, () => {
      expect(contrastRatio(t.page, t.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.surface, t.accent)).toBeGreaterThanOrEqual(3);
    });
    it(`${l.id}: the composed input boundary (never the decorative line) is >= 3:1`, () => {
      const c = composeStoreTheme({ template: 'dahab', look: l.id, theme: null });
      expect(
        contrastRatio(`hsl(${c.backgroundColor})`, `hsl(${c.inputColor})`)
      ).toBeGreaterThanOrEqual(3);
    });
  }
  it('Worn and Gift box keep the decorative line under 3:1, so it can never draw an interactive boundary', () => {
    for (const id of ['dahab.worn', 'dahab.giftbox']) {
      const t = by(id);
      expect(contrastRatio(t.page, t.line), id).toBeLessThan(3);
    }
  });
  it('Workshop champagne reads on the teal page and the surface (hairlines, maker details)', () => {
    const t = by('dahab.workshop');
    expect(contrastRatio(t.page, '#D8C9A8')).toBeGreaterThanOrEqual(5.9);
    expect(contrastRatio(t.surface, '#D8C9A8')).toBeGreaterThanOrEqual(4.5);
  });
  it('Workshop sale chip: the pomegranate is a FILL with ink text, never a text colour', () => {
    const t = by('dahab.workshop');
    expect(contrastRatio('#E8606A', '#10151C')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.page, '#E8606A')).toBeLessThan(4.5);
  });
  it('Gift box champagne reads on the emerald band', () => {
    expect(contrastRatio(by('dahab.giftbox').primary, '#D8C9A8')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('Rulings B5-2 / METAL-1: no orange anywhere in a Dahab look', () => {
  for (const l of dahab) {
    it(`${l.id}: no colour token is in the forbidden hue band`, () => {
      const t = l.tokens;
      for (const k of [
        'page',
        'surface',
        'ink',
        'muted',
        'primary',
        'onPrimary',
        'accent',
        'line',
      ] as const)
        expect(isForbiddenOrange(t[k]), `${l.id}.${k} ${t[k]}`).toBe(false);
      if (t.onAccent) expect(isForbiddenOrange(t.onAccent), `${l.id}.onAccent`).toBe(false);
    });
    it(`${l.id}: no composed theme colour (every role the look paints) is orange`, () => {
      const c = composeStoreTheme({ template: 'dahab', look: l.id, theme: null }) as Record<
        string,
        unknown
      >;
      const keys = Object.keys(c).filter(
        k =>
          /Color$|Foreground$/.test(k) && typeof c[k] === 'string' && triplet.test(c[k] as string)
      );
      expect(keys.length).toBeGreaterThan(10);
      for (const k of keys)
        expect(isForbiddenOrange(c[k] as string), `${l.id} ${k}=${c[k]}`).toBe(false);
    });
    it(`${l.id}: every CSS variable the theme emits is outside the band`, () => {
      const theme = composeStoreTheme({ template: 'dahab', look: l.id, theme: null });
      const vars = themeToCssVars(theme, l.id) as Record<string, string>;
      const colourVars = Object.entries(vars).filter(([, v]) => triplet.test(v));
      expect(colourVars.length).toBeGreaterThan(20);
      const bad = colourVars.filter(([, v]) => isForbiddenOrange(v)).map(([k, v]) => `${k}=${v}`);
      expect(bad).toEqual([]);
    });
  }
  it('the skin theme under the looks is not orange either (legacy look = null row)', () => {
    for (const [k, v] of Object.entries(TEMPLATE_THEMES.dahab))
      if (typeof v === 'string' && triplet.test(v)) expect(isForbiddenOrange(v), k).toBe(false);
  });
  it('the legacy skin theme is the neutral base: white page, ink primary, no night, no gold', () => {
    const t = TEMPLATE_THEMES.dahab;
    expect(t.backgroundColor).toBe('0 0% 100%');
    expect(t.primaryColor).toBe('0 0% 8%');
    expect(JSON.stringify(t)).not.toMatch(/222 29%|39 49%|40 62%/);
    expect(TEMPLATE_LAYOUT_BASELINES.dahab).toBeDefined();
  });
});

describe('merchant-extreme colours on dahab looks (merchants may pick any colour; never validated)', () => {
  const EXTREMES = ['#FFFFFF', '#000000', '#FFFF00', '#FF00FF', '#00FFFF', '#808080', '#777777'];
  const ratio = (surface: string, fg: string) => contrastRatio(surface, `hsl(${fg})`);
  for (const l of dahab)
    for (const c of EXTREMES)
      it(`${l.id}: primary/accent ${c} keeps button and chip text legible`, () => {
        const theme = composeStoreTheme({
          template: 'dahab',
          look: l.id,
          theme: { primaryColor: hexToHsl(c), accentColor: hexToHsl(c) },
        });
        const roles = deriveBrandRoles(theme);
        expect(ratio(c, roles['--primary-foreground'])).toBeGreaterThanOrEqual(4.5);
        expect(ratio(c, roles['--accent-foreground'])).toBeGreaterThanOrEqual(2);
      });
});
