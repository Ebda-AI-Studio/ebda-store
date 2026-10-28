import { describe, it, expect } from 'vitest';
import { DEFAULT_THEME, parseColorToRgb, resolveBackgroundPreset } from '@ebda/shared';
import { resolveFooterAutoContrastBg } from './footer-logo-bg';

/**
 * Issue #139 — `ShopChrome`'s footer-logo auto-contrast filter assumes the footer paints
 * `--bg-section-alt`. The one footer that painted `bg-foreground` (the deleted bold skin, with
 * `personaChromeV2`) is gone (Ruling SKIN-DEL-5): the flag is accepted by the theme schema and
 * ignored, so it must never move the computed background.
 */
describe('resolveFooterAutoContrastBg', () => {
  it('uses the theme default (section-alt)', () => {
    const expected = `hsl(${resolveBackgroundPreset(DEFAULT_THEME).bgSectionAlt})`;
    expect(resolveFooterAutoContrastBg(DEFAULT_THEME, undefined)).toBe(expected);
  });

  it('ignores personaChromeV2 (accepted-and-ignored, SKIN-DEL-5)', () => {
    const expected = `hsl(${resolveBackgroundPreset(DEFAULT_THEME).bgSectionAlt})`;
    const withFlag = { ...DEFAULT_THEME, personaChromeV2: true };
    expect(resolveFooterAutoContrastBg(withFlag, undefined)).toBe(expected);
  });

  it('an explicit merchant bgColor override always wins', () => {
    const withFlag = { ...DEFAULT_THEME, personaChromeV2: true };
    expect(resolveFooterAutoContrastBg(withFlag, '#101010')).toBe('#101010');
  });
});

// Issue #2156 — hex / token-stored theme colors must yield a PARSEABLE color,
// not `hsl(#1a1a1a)`, or the logo contrast filter silently becomes 'none'.
describe('resolveFooterAutoContrastBg — non-triplet stored colors (#2156)', () => {
  it('a hex-saved custom section-alt is normalized', () => {
    const theme = {
      ...DEFAULT_THEME,
      bgPage: '#faf8f3',
      bgSectionAlt: '#f4f1ea',
    } as typeof DEFAULT_THEME;
    // precondition: the merchant-set value reaches the resolver unnormalized
    expect(resolveBackgroundPreset(theme).bgSectionAlt).toBe('#f4f1ea');
    const bg = resolveFooterAutoContrastBg(theme, undefined);
    expect(bg).not.toContain('#');
    expect(parseColorToRgb(bg)).not.toBeNull();
  });
});
