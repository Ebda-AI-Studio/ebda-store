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
      composeStoreTheme({ template: 'minimal', look: 'qamar.atelier', theme: {} }),
      'qamar.atelier'
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
      composeStoreTheme({ template: 'minimal', look: 'lamma.market', theme: {} }),
      'lamma.market'
    );
    expect(css).toContain('--space-unit: 0.875');
    expect(css).toContain('--image-ratio: 1 / 1');
    expect(css).toContain('--motion-duration: 280ms');
  });
  it('a stray density/fonts on a legacy store (no look) emits nothing', () => {
    const css = buildThemeStyleTag(
      composeStoreTheme({
        template: 'minimal',
        theme: { density: 'airy', headingFont: 'Cairo', motion: 'expressive' },
      })
    );
    expect(css).not.toMatch(
      /--(font-|look-font|space-unit|image-ratio|motion-duration)[a-z-]*: (?!var\(--font-sans)/
    );
    expect(css).not.toContain('--space-unit');
    expect(css).not.toContain('--font-display');
  });
  it('a look store whose merchant cleared density still gets font vars; --font-latin follows the look', () => {
    const theme = composeStoreTheme({ template: 'minimal', look: 'qamar.atelier', theme: {} });
    delete (theme as { density?: string }).density;
    const css = buildThemeStyleTag(theme, 'qamar.atelier');
    expect(css).toContain('--font-display: "Noto Naskh Arabic"');
    expect(css).toContain('--look-font-display: "Noto Naskh Arabic"');
    expect(css).toContain('--font-latin: "Cormorant Garamond", var(--font-sans)');
    expect(css).not.toContain('--space-unit');
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

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('globals.css look rules', () => {
  const css = readFileSync(path.join(__dirname, '../../apps/web/src/styles/globals.css'), 'utf8');
  const looksCss = css.slice(css.indexOf('Looks (Phase S)'));
  it('spacing scales only on the default marker, never on the class triple', () => {
    expect(looksCss).toMatch(/\[data-look\] \.sp-top-default/);
    expect(looksCss).not.toMatch(/\.py-12|\.pt-12|\.pb-12/);
  });
  it('no global card-image or [data-section] rule (merchant presets win)', () => {
    expect(looksCss).not.toMatch(/group\\\/img/);
    expect(looksCss).not.toMatch(/\[data-section\]/);
  });
  it('the look display face beats the dahab skin on <body>', () => {
    expect(looksCss).toMatch(
      /html\[lang\] body\[data-look\]\[data-pack='dahab'\]\s*\{\s*--font-display:\s*var\(--look-font-display\)/
    );
  });
  it('English headings use the Latin display face', () => {
    expect(looksCss).toMatch(
      /html\[lang='en'\] \[data-look\] h1[\s\S]*font-family:\s*var\(--font-latin/
    );
  });
  it('every look rule is scoped under [data-look]', () => {
    const rules = looksCss.replace(/\/\*[\s\S]*?\*\//g, '').match(/^[^@\s}][^{]*\{/gm) ?? [];
    for (const r of rules) expect(r, r).toMatch(/data-look/);
  });
});
