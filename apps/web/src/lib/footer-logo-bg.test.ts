import { describe, it, expect } from 'vitest';
import { DEFAULT_THEME, resolveBackgroundPreset } from '@force/shared';
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
