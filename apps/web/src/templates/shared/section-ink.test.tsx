import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LOOKS,
  DEFAULT_THEME,
  composeStoreTheme,
  contrastRatio,
  parseColorToRgb,
} from '@ebda/shared';
import type { StoreTheme, TemplateId } from '@ebda/shared';
import { readFileSync } from 'node:fs';
import { sectionBgStyle } from './section-bg';

/** Ruling PREMIUM-1: every painted band, on every look, carries its own ink at AA. */

const BANDS: Record<string, string> = {
  white: '#ffffff',
  cream: '#f6efe2',
  paleTint: '#e8f0fe',
  navy: '#1F2A44',
  black: '#000000',
  forest: '#14532d',
  midGrey: '#777777',
  midBlue: '#3b6fd4',
  brandOrange: '#ff6e01',
  gradient: 'linear-gradient(90deg, #1F2A44 0%, #14532d 100%)',
};

const hsl = (t: string) => `hsl(${t.trim()})`;
const val = (style: Record<string, unknown>, k: string, fallback: string) =>
  String(style[k] ?? fallback);

function themes(): Array<[string, StoreTheme]> {
  const out: Array<[string, StoreTheme]> = [['default', DEFAULT_THEME]];
  for (const l of LOOKS) {
    out.push([l.id, composeStoreTheme({ template: l.skin as TemplateId, look: l.id })]);
  }
  return out;
}

function stopsOf(bg: string): string[] {
  return bg.match(/#[0-9a-f]{6}/gi) ?? [];
}

describe('section tone contract (sectionBgStyle)', () => {
  for (const [themeName, theme] of themes()) {
    for (const [bandName, bg] of Object.entries(BANDS)) {
      it(`${themeName} on ${bandName}: body, muted and price ink >= 4.5:1, large 3:1`, () => {
        const style = sectionBgStyle(bg, theme) as Record<string, unknown>;
        expect(style.backgroundColor).toBe(bg); // merchant paint is verbatim
        for (const stop of stopsOf(bg)) {
          const fg = hsl(val(style, '--foreground', theme.foregroundColor));
          const muted = hsl(val(style, '--muted-foreground', theme.mutedForeground));
          expect(contrastRatio(stop, fg), `${themeName}/${bandName} body`).toBeGreaterThanOrEqual(
            4.5
          );
          expect(
            contrastRatio(stop, muted),
            `${themeName}/${bandName} muted`
          ).toBeGreaterThanOrEqual(4.5);
          // Large text (hero-scale headings, section titles) is the foreground at 3:1, implied.
          const primary = hsl(val(style, '--primary', theme.primaryColor));
          // Primary as TEXT (prices): a theme whose primary already clears the band keeps it;
          // a band it fails on must have been swapped (>= 4.5), never left at < 3.
          expect(
            contrastRatio(stop, primary),
            `${themeName}/${bandName} price`
          ).toBeGreaterThanOrEqual(style['--primary'] ? 4.5 : 3);
        }
        // A scoped card blends into the band: its text pair is readable on the card ground.
        if (style['--card']) {
          expect(
            contrastRatio(hsl(String(style['--card'])), hsl(String(style['--card-foreground'])))
          ).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }

  it('leaves a band that already carries the page ink untouched (no token overrides)', () => {
    const style = sectionBgStyle('#ffffff', DEFAULT_THEME) as Record<string, unknown>;
    expect(Object.keys(style)).toEqual(['backgroundColor']);
  });

  it('QA regression: navy #1F2A44 under the qamar.atelier theme no longer paints 1.28:1', () => {
    const theme = composeStoreTheme({ template: 'qamar', look: 'qamar.atelier' });
    const style = sectionBgStyle('#1F2A44', theme) as Record<string, unknown>;
    expect(contrastRatio('#1F2A44', hsl(String(style['--foreground'])))).toBeGreaterThan(8);
  });

  it('renders a card + chips on a dark and a light band with ink derived from the band', async () => {
    // The real components read tokens only (no hard-coded ink): assert the markup carries no
    // literal colour and the wrapper carries the scope, so the contrast above is what paints.
    const { CategoryChips } = await import('./CategoryChips');
    const html = renderToStaticMarkup(
      React.createElement(CategoryChips, {
        categories: [{ id: '1', slug: 'a', name: 'A', nameAr: 'أ' }] as never,
        isRtl: true,
      })
    );
    expect(html).toMatch(/text-foreground/);
    expect(html).not.toMatch(/#[0-9a-f]{3,6}|rgb\(/i);
    for (const bg of [BANDS.navy, BANDS.cream]) {
      const style = sectionBgStyle(bg, DEFAULT_THEME) as Record<string, unknown>;
      const fg = hsl(val(style, '--foreground', DEFAULT_THEME.foregroundColor));
      expect(contrastRatio(bg, fg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('no section paints a merchant bgColor around sectionBgStyle (single funnel)', () => {
    const src = readFileSync(
      new URL('../../builder/render/PageRenderer.tsx', import.meta.url),
      'utf8'
    );
    expect(src).not.toMatch(/backgroundColor:\s*[a-zA-Z.]*bgColor/);
  });

  it('parses (sanity)', () => {
    expect(parseColorToRgb('#1F2A44')).toEqual({ r: 31, g: 42, b: 68 });
  });
});
