import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LOOKS, contrastRatio, composeStoreTheme, deriveBrandRoles, hexToHsl } from '@ebda/shared';
import {
  FULL_BLEED_SCRIM,
  FULL_BLEED_TEXT,
} from '../../apps/web/src/builder/sections/ImageTextSection';
import { getPackStyles, QAMAR_HERO_SCRIM } from '../../apps/web/src/templates/shared/pack-styles';
import { HERO_COLLAGE_TEXT_PANEL } from '../../apps/web/src/templates/shared/HeroCollage';

const qamar = LOOKS.filter(l => l.template === 'qamar');
// Every text pair a Qamar skin paints, beyond the generic set in looks-contrast.test.ts.
const PAIRS: [string, (t: any) => [string, string]][] = [
  ['ink on surface', t => [t.surface, t.ink]],
  ['accent text on surface (prices, active)', t => [t.surface, t.accent]],
  ['onPrimary on accent (accentForeground)', t => [t.accent, t.onPrimary]],
  ['primary text on page (links, chips active)', t => [t.page, t.primary]],
];

const hex = (n: number[]) => '#' + n.map(c => Math.round(c).toString(16).padStart(2, '0')).join('');
const rgb = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const over = (fg: string, a: number, bg: string) => {
  const f = rgb(fg);
  const b = rgb(bg);
  return hex(f.map((c, i) => c * a + b[i] * (1 - a)));
};

describe('qamar looks: skin-painted text pairs >= 4.5', () => {
  it('there are exactly three Qamar looks', () =>
    expect(qamar.map(l => l.id).sort()).toEqual([
      'qamar.atelier',
      'qamar.lookbook',
      'qamar.vitrine',
    ]));
  for (const l of qamar)
    for (const [label, pick] of PAIRS)
      it(`${l.id}: ${label}`, () => {
        const [bg, fg] = pick(l.tokens);
        expect(contrastRatio(bg, fg)).toBeGreaterThanOrEqual(4.5);
      });
});

describe('full-bleed panel keeps white text legible over the worst photo pixel (C15)', () => {
  it('panel constants are the ones the component paints', () => {
    expect(FULL_BLEED_TEXT).toBe('#FFFFFF');
    expect(FULL_BLEED_SCRIM.opacity).toBeLessThan(1);
  });
  for (const l of qamar)
    for (const [name, photo] of [
      ['white', '#FFFFFF'],
      ['black', '#000000'],
    ] as const)
      it(`${l.id}: text on panel over a ${name} photo pixel`, () => {
        // The panel is look-independent today; the loop makes a future per-look
        // panel colour fail here instead of shipping unmeasured.
        const panel = over(FULL_BLEED_SCRIM.color, FULL_BLEED_SCRIM.opacity, photo);
        expect(contrastRatio(panel, FULL_BLEED_TEXT)).toBeGreaterThanOrEqual(4.5);
      });
});

// STOP 1 critique: the qamar hero headline is white (HeroBanner's fallback) and was painted over
// a transparent centre, so it vanished on a light Atelier photo. The scrim is ink, densest at the
// centre where the headline sits; the headline is large text (>= 24px bold), so AA is 3:1.
describe('qamar hero scrim keeps the white headline legible over a white photo', () => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(QAMAR_HERO_SCRIM.color.slice(i, i + 2), 16));
  it('the class paints exactly the constant', () => {
    expect(getPackStyles('qamar').heroOverlay).toContain(
      `rgb(${r}_${g}_${b}/${QAMAR_HERO_SCRIM.centre})_0%,rgb(${r}_${g}_${b}/${QAMAR_HERO_SCRIM.centre})_${QAMAR_HERO_SCRIM.plateau}%`
    );
    expect(getPackStyles('qamar').heroOverlay).toContain(
      `rgb(${r}_${g}_${b}/${QAMAR_HERO_SCRIM.edge})_100%`
    );
  });
  it('white over the centre scrim on a white pixel is >= 3:1 (large text)', () => {
    const bg = over(QAMAR_HERO_SCRIM.color, QAMAR_HERO_SCRIM.centre, '#FFFFFF');
    expect(contrastRatio(bg, '#FFFFFF')).toBeGreaterThanOrEqual(3);
  });
  it('the subheadline (normal text, HeroBanner `text-white/90`) is >= 4.5:1 over the plateau on a white pixel', () => {
    const bg = over(QAMAR_HERO_SCRIM.color, QAMAR_HERO_SCRIM.centre, '#FFFFFF');
    const sub = over('#FFFFFF', 0.9, bg);
    expect(contrastRatio(bg, sub)).toBeGreaterThanOrEqual(4.5);
    // HeroBanner still paints the subheadline as white/90 (the measured pair)
    const src = readFileSync(
      path.resolve(__dirname, '../../apps/web/src/templates/shared/HeroBanner.tsx'),
      'utf8'
    );
    expect(src).toMatch(/text-white\/90 drop-shadow/);
  });
});

// C28 / Task 7: the Lookbook hero (collage) puts its headline + CTA on an OPAQUE panel of the
// page colour, never over a photo: on Lookbook that is a dark solid surface under light ink.
// Measured BY IMPORT at the worst text position — the panel edge next to the photos, over a
// white or a black photo pixel — for every Qamar look, plus the CTA pair on the panel. When the
// collage falls back to the banner (< 3 photos), the qamar hero scrim above applies.
describe('collage hero text panel (C28): light text on a dark solid panel on Lookbook', () => {
  it('the panel is the page colour at full opacity, as the component paints it', () => {
    expect(HERO_COLLAGE_TEXT_PANEL).toEqual({ token: 'background', opacity: 1 });
    const src = readFileSync(
      path.resolve(__dirname, '../../apps/web/src/templates/shared/HeroCollage.tsx'),
      'utf8'
    );
    expect(src).toMatch(/data-part="collage-text"\s+className="[^"]*\bbg-background\b(?!\/)/);
  });
  it('Lookbook: the panel is dark and the ink is light', () => {
    const t = qamar.find(l => l.id === 'qamar.lookbook')!.tokens;
    expect(contrastRatio('#000000', t.page)).toBeLessThan(contrastRatio('#000000', t.ink));
  });
  for (const l of qamar)
    for (const [name, photo] of [
      ['white', '#FFFFFF'],
      ['black', '#000000'],
    ] as const)
      it(`${l.id}: headline ink and CTA on the panel over a ${name} photo pixel`, () => {
        const panel = over(l.tokens.page, HERO_COLLAGE_TEXT_PANEL.opacity, photo);
        expect(contrastRatio(panel, l.tokens.ink)).toBeGreaterThanOrEqual(4.5);
        // the CTA is bg-primary / text-primary-foreground on that panel
        expect(contrastRatio(l.tokens.primary, l.tokens.onPrimary)).toBeGreaterThanOrEqual(4.5);
      });
});

// C9: a merchant who picks extreme primary/accent colours on a Qamar look still gets
// readable button/badge text through the storefront's brand-role guard
// (deriveBrandRoles, the same call themeToCssVars spreads last).
describe('merchant-extreme colours on qamar looks', () => {
  const EXTREMES = ['#FFFFFF', '#000000', '#FFFF00', '#FF00FF', '#00FFFF', '#808080', '#777777'];
  const ratio = (surface: string, fgTriple: string) => contrastRatio(surface, `hsl(${fgTriple})`);
  for (const l of qamar)
    for (const c of EXTREMES)
      it(`${l.id}: primary/accent ${c} keeps foreground legible`, () => {
        const theme = composeStoreTheme({
          template: 'qamar',
          look: l.id,
          theme: { primaryColor: hexToHsl(c), accentColor: hexToHsl(c) },
        });
        const roles = deriveBrandRoles(theme);
        // The guard's floor is 2:1 for a kept stored foreground (deliberate brand picks);
        // anything below is replaced with black/white (>= 4.58). Never invisible.
        expect(ratio(c, roles['--primary-foreground'])).toBeGreaterThanOrEqual(2);
        expect(ratio(c, roles['--accent-foreground'])).toBeGreaterThanOrEqual(2);
      });
});
