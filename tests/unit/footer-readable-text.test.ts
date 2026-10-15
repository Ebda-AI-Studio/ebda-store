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

describe('wiring: every skin footer renders inside the readable wrapper', () => {
  const chrome = readFileSync(path.join(root, 'apps/web/src/components/ShopChrome.tsx'), 'utf8');
  const css = readFileSync(path.join(root, 'apps/web/src/styles/globals.css'), 'utf8');
  it('ShopChrome derives the vars from the resolved footer colour and marks the surface', () => {
    expect(chrome).toMatch(/readableTextVars\(\s*layout\?\.footer\?\.bgColor/);
    expect(chrome).toMatch(/'data-footer-surface': 'custom'/);
    expect(chrome).toMatch(/'--muted-foreground': footerText\.muted/);
    // the wrapper is the one around <T.Footer>, i.e. every skin incl. Dahab and qamar
    const wrap = chrome.indexOf("'data-footer-surface'");
    expect(chrome.indexOf('<T.Footer', wrap)).toBeGreaterThan(wrap);
  });
  it('globals.css collapses translucent text variants onto the guaranteed tone', () => {
    expect(css).toMatch(
      /\[data-footer-surface='custom'\] \[class\*='text-foreground\/'\],\s*\[data-footer-surface='custom'\] \[class\*='text-muted-foreground'\] \{\s*color: hsl\(var\(--muted-foreground\)\);/
    );
  });
});
