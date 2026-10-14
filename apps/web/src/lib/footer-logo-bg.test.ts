import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THEME,
  footerLogoContrastFilter,
  parseColorToRgb,
  resolveBackgroundPreset,
} from '@ebda/shared';
import { resolveFooterAutoContrastBg } from './footer-logo-bg';

/**
 * Issue #139 — `ShopChrome`'s footer-logo auto-contrast filter assumed the
 * footer always paints `--bg-section-alt`, the default for all 5 themes.
 * `templates/bold/Footer.tsx` has a THIRD case the computation missed:
 * `invertFooter = theme?.personaChromeV2 === true && !bgColor` paints
 * `bg-foreground` instead — a bold-theme merchant with `personaChromeV2` on
 * and no explicit `bgColor` override got the auto-contrast filter computed
 * against the wrong assumed background.
 */
describe('resolveFooterAutoContrastBg', () => {
  it('uses the theme default (section-alt) for every non-bold template', () => {
    const expected = `hsl(${resolveBackgroundPreset(DEFAULT_THEME).bgSectionAlt})`;
    for (const template of ['modern', 'classic', 'minimal', 'elegant'] as const) {
      expect(resolveFooterAutoContrastBg(template, DEFAULT_THEME, undefined)).toBe(expected);
    }
  });

  it('uses the theme default (section-alt), not --foreground, for bold WITHOUT personaChromeV2', () => {
    const expected = `hsl(${resolveBackgroundPreset(DEFAULT_THEME).bgSectionAlt})`;
    expect(resolveFooterAutoContrastBg('bold', DEFAULT_THEME, undefined)).toBe(expected);
  });

  it("uses --foreground for bold's personaChromeV2 invert (no bgColor override)", () => {
    const invertedTheme = { ...DEFAULT_THEME, personaChromeV2: true };

    expect(resolveFooterAutoContrastBg('bold', invertedTheme, undefined)).toBe(
      `hsl(${invertedTheme.foregroundColor})`
    );
  });

  it('does NOT apply the bold invert background when personaChromeV2 is off', () => {
    const plainBoldTheme = { ...DEFAULT_THEME, personaChromeV2: false };

    expect(resolveFooterAutoContrastBg('bold', plainBoldTheme, undefined)).not.toBe(
      `hsl(${plainBoldTheme.foregroundColor})`
    );
  });

  it("does NOT apply bold's invert background for a non-bold template even with personaChromeV2 on", () => {
    const invertedTheme = { ...DEFAULT_THEME, personaChromeV2: true };

    expect(resolveFooterAutoContrastBg('modern', invertedTheme, undefined)).not.toBe(
      `hsl(${invertedTheme.foregroundColor})`
    );
  });

  it("an explicit merchant bgColor override always wins, even for bold's invert case", () => {
    const invertedTheme = { ...DEFAULT_THEME, personaChromeV2: true };

    expect(resolveFooterAutoContrastBg('bold', invertedTheme, '#101010')).toBe('#101010');
  });
});

// Issue #2156 — hex / token-stored theme colors must yield a PARSEABLE color,
// not `hsl(#1a1a1a)`, or the logo contrast filter silently becomes 'none'.
describe('resolveFooterAutoContrastBg — non-triplet stored colors (#2156)', () => {
  it('bold invert with a HEX foregroundColor → parseable dark background', () => {
    const theme = { ...DEFAULT_THEME, personaChromeV2: true, foregroundColor: '#1a1a1a' };
    const bg = resolveFooterAutoContrastBg('bold', theme, undefined);
    expect(bg).not.toContain('#');
    expect(parseColorToRgb(bg)).not.toBeNull();
    expect(footerLogoContrastFilter(bg)).not.toBe('none');
  });

  it('bold invert with a token:* foregroundColor resolves the token', () => {
    const theme = { ...DEFAULT_THEME, personaChromeV2: true, foregroundColor: 'token:primary' };
    const bg = resolveFooterAutoContrastBg('bold', theme, undefined);
    expect(bg).not.toContain('token:');
    expect(parseColorToRgb(bg)).not.toBeNull();
  });

  it('a hex-saved custom section-alt is normalized too', () => {
    const theme = {
      ...DEFAULT_THEME,
      bgPage: '#faf8f3',
      bgSectionAlt: '#f4f1ea',
    } as typeof DEFAULT_THEME;
    // precondition: the merchant-set value reaches the resolver unnormalized
    expect(resolveBackgroundPreset(theme).bgSectionAlt).toBe('#f4f1ea');
    const bg = resolveFooterAutoContrastBg('modern', theme, undefined);
    expect(bg).not.toContain('#');
    expect(parseColorToRgb(bg)).not.toBeNull();
  });
});
