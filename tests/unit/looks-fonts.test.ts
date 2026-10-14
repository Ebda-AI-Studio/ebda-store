import { describe, it, expect } from 'vitest';
import { LOOKS, lookFontsHref, composeStoreTheme } from '@force/shared';
import { buildThemeStyleTag } from '../../apps/web/src/lib/theme-css';

describe('look fonts', () => {
  it('one Google Fonts css2 URL per look with exactly its families, display=swap', () => {
    for (const l of LOOKS) {
      const u = new URL(lookFontsHref(l));
      expect(u.origin + u.pathname).toBe('https://fonts.googleapis.com/css2');
      expect(u.searchParams.getAll('family')).toHaveLength(
        new Set(Object.values(l.tokens.fonts)).size
      );
      expect(u.searchParams.get('display')).toBe('swap');
    }
  });
  it('display/body stacks end in the platform Arabic + sans fallbacks', () => {
    const css = buildThemeStyleTag(
      composeStoreTheme({ template: 'minimal', look: 'qamar.atelier', theme: {} })
    );
    expect(css).toMatch(
      /--font-display:\s*"Noto Naskh Arabic", var\(--font-arabic\), var\(--font-sans\)/
    );
    expect(css).toMatch(
      /--font-body:\s*"IBM Plex Sans Arabic", var\(--font-arabic\), var\(--font-sans\)/
    );
  });
  it('density, ratio and motion become vars', () => {
    const css = buildThemeStyleTag(
      composeStoreTheme({ template: 'minimal', look: 'lamma.market', theme: {} })
    );
    expect(css).toContain('--space-unit: 0.875');
    expect(css).toContain('--image-ratio: 1 / 1');
    expect(css).toContain('--motion-duration: 280ms');
  });
  it('a legacy theme emits none of the look vars', () => {
    const css = buildThemeStyleTag(composeStoreTheme({ template: 'minimal', theme: {} }));
    expect(css).not.toMatch(
      /--(font-display|font-body|font-latin|space-unit|image-ratio|motion-duration)/
    );
    // even a stored headingFont does not turn a legacy store into a look store
    const css2 = buildThemeStyleTag(
      composeStoreTheme({ template: 'minimal', theme: { headingFont: 'Cairo' } })
    );
    expect(css2).not.toContain('--font-display');
  });
});
