/**
 * Ruling B1-27: a merchant-coloured footer keeps every text tone >= 4.5:1 on EVERY skin.
 * ShopChrome re-derives --foreground / --muted-foreground from the resolved footer colour
 * (`readableTextVars`), and globals.css collapses the skins' translucent text variants onto the
 * guaranteed muted tone. The STOP 1 defect it closes: minimal's `text-muted-foreground` links on a
 * `token:primary` footer measured 2.6:1 (#5C5C5C on #141414).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  contrastRatio,
  readableTextVars,
  footerTextOverride,
  resolveColor,
  getTemplateTheme,
  TEMPLATE_LAYOUT_BASELINES,
  hexToHsl,
} from '@ebda/shared';

const root = path.resolve(__dirname, '../..');
const SURFACES = [
  '#141414', // Atelier ink / a near-black brand
  '#0A0A0A', // minimal preset primary
  '#1F4E54', // Vitrine teal
  '#7C2D12', // burgundy
  '#E8A33D', // Lookbook saffron (light-medium: black text)
  '#FF6E00', // orange, the flip-point case
  '#808080', // mid grey, the hardest surface
  '#FFFFFF',
];

describe('readableTextVars keeps foreground and muted >= 4.5:1 on any surface', () => {
  for (const bg of SURFACES)
    it(bg, () => {
      const v = readableTextVars(bg)!;
      expect(v).toBeDefined();
      expect(contrastRatio(bg, v.fg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(bg, v.mutedHex)).toBeGreaterThanOrEqual(4.5);
    });
  it('unparseable surface -> undefined (the theme tokens stay)', () => {
    expect(readableTextVars('var(--x)')).toBeUndefined();
    expect(readableTextVars(undefined)).toBeUndefined();
  });
});

describe('a NON-Qamar skin with a dark brand colour on its default footer', () => {
  it('minimal baseline footer = token:primary, a dark primary resolves to a readable pair', () => {
    expect(TEMPLATE_LAYOUT_BASELINES.minimal.footer?.bgColor).toBe('token:primary');
    const theme = { ...getTemplateTheme('minimal'), primaryColor: hexToHsl('#141414') };
    const bg = resolveColor('token:primary', theme)!;
    const v = readableTextVars(bg)!;
    // before B1-27 the minimal footer painted the theme's muted grey here: 2.6:1
    expect(contrastRatio('#141414', '#5C5C5C')).toBeLessThan(4.5);
    expect(contrastRatio(bg, v.mutedHex)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the override acts ONLY when the skin footer fails (review N1)', () => {
  const theme = getTemplateTheme('modern');
  it('a readable footer (white surface, theme ink) gets no override: byte-identical to main', () => {
    expect(footerTextOverride('#FFFFFF', theme)).toBeUndefined();
    expect(footerTextOverride('hsl(0 0% 100%)', theme)).toBeUndefined();
  });
  it('a light brand footer the theme ink already passes on keeps its shades', () => {
    // pale sand footer: dark ink 4.5+ even at 55% alpha and the muted tone at 70%
    expect(
      footerTextOverride('#FFFFFF', { foregroundColor: '0 0% 0%', mutedForeground: '0 0% 30%' })
    ).toBeUndefined();
  });
  it('a dark-brand footer on a legacy skin gets the readable pair', () => {
    for (const t of ['minimal', 'elegant', 'modern', 'classic', 'bold'] as const) {
      const th = { ...getTemplateTheme(t), primaryColor: hexToHsl('#141414') };
      const bg = resolveColor('token:primary', th)!;
      const v = footerTextOverride(bg, th);
      expect(v, t).toBeDefined();
      expect(contrastRatio(bg, v!.mutedHex), t).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('wiring: every skin footer renders inside the readable wrapper', () => {
  const chrome = readFileSync(path.join(root, 'apps/web/src/components/ShopChrome.tsx'), 'utf8');
  const css = readFileSync(path.join(root, 'apps/web/src/styles/globals.css'), 'utf8');
  it('ShopChrome derives the vars from the resolved footer colour and marks the surface', () => {
    expect(chrome).toMatch(/footerTextOverride\(\s*layout\?\.footer\?\.bgColor/);
    expect(chrome).toMatch(/'data-footer-surface': 'custom'/);
    expect(chrome).toMatch(/'--muted-foreground': footerText\.muted/);
    // the wrapper is the one around <T.Footer>, i.e. every skin incl. Dahab and qamar
    const wrap = chrome.indexOf("'data-footer-surface'");
    expect(chrome.indexOf('<T.Footer', wrap)).toBeGreaterThan(wrap);
  });
  it('globals.css collapses translucent TEXT variants, never form controls (N2)', () => {
    expect(css).toMatch(
      /\[data-footer-surface='custom'\]\s*:is\(\[class\*='text-foreground\/'\], \[class\*='text-muted-foreground'\]\):not\(input, textarea, select\) \{\s*color: hsl\(var\(--muted-foreground\)\);/
    );
    // a light-surfaced field (elegant newsletter) gets the theme ink back
    expect(css).toMatch(/:is\(input, textarea, select\):is\(\s*\[class\*='bg-background'\]/);
    expect(chrome).toMatch(/'--ctl-foreground': store\?\.theme\?\.foregroundColor/);
    // a solid bg-foreground control's label is the opposite ink, never its own fill
    expect(chrome).toMatch(
      /'--footer-on-fg': footerText\.fg === '#ffffff' \? '0 0% 0%' : '0 0% 100%'/
    );
    expect(css).toMatch(
      /\[data-footer-surface='custom'\] \[class~='bg-foreground'\] \{\s*color: hsl\(var\(--footer-on-fg\)\);/
    );
  });
});
