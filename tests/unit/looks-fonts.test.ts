import { describe, it, expect } from 'vitest';
import {
  LOOKS,
  LOOK_FONT_SPECS,
  getLook,
  lookFontsHref,
  composeStoreTheme,
  type StoreTheme,
} from '@ebda/shared';
import { buildThemeStyleTag, LOOK_VAR_PATTERNS } from '../../apps/web/src/lib/theme-css';
import { lookHead } from '../../apps/web/src/lib/look-head';

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
      composeStoreTheme({ template: 'qamar', look: 'qamar.atelier', theme: {} }),
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
      composeStoreTheme({ template: 'qamar', look: 'lamma.market', theme: {} }),
      'lamma.market'
    );
    expect(css).toContain('--space-unit: 0.875');
    expect(css).toContain('--image-ratio: 1 / 1');
    expect(css).toContain('--motion-duration: 280ms');
  });
  it('a stray density/fonts on a legacy store (no look) emits nothing', () => {
    const css = buildThemeStyleTag(
      composeStoreTheme({
        template: 'qamar',
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
    const theme = composeStoreTheme({ template: 'qamar', look: 'qamar.atelier', theme: {} });
    delete (theme as { density?: string }).density;
    const css = buildThemeStyleTag(theme, 'qamar.atelier');
    expect(css).toContain('--font-display: "Noto Naskh Arabic"');
    expect(css).toContain('--look-font-display: "Noto Naskh Arabic"');
    expect(css).toContain('--font-latin: "Cormorant Garamond", var(--font-sans)');
    expect(css).not.toContain('--space-unit');
  });
  it('a legacy theme emits none of the look vars', () => {
    const css = buildThemeStyleTag(composeStoreTheme({ template: 'qamar', theme: {} }));
    expect(css).not.toMatch(
      /--(font-display|font-body|font-latin|space-unit|image-ratio|motion-duration)/
    );
    // even a stored headingFont does not turn a legacy store into a look store
    const css2 = buildThemeStyleTag(
      composeStoreTheme({ template: 'qamar', theme: { headingFont: 'Cairo' } })
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
    // TEMPLATES-MOCK-7/-8: the only allowed use is as the ANCESTOR scope of the card-chrome / product-grid
    // trait rules (they restyle descendants on the home sections, never the section itself).
    expect(looksCss).not.toMatch(
      /\[data-section\](?! \[data-(?:card-chrome='(?:heart|swatches|tags)'|part='product-grid')\])/
    );
  });
  it('the retired dahab skin no longer overrides --font-display on <body> (Ruling B5-1)', () => {
    expect(looksCss).not.toMatch(/data-pack='dahab'\]\s*\{\s*--font-display/);
    expect(css).not.toMatch(/--font-dahab|dahab-draw|dahab-rise|Amiri|Marcellus/);
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

describe('merchant font override on a look store (LOOKS-3: merchant wins)', () => {
  const atelier = getLook('qamar.atelier')!;
  const families = (href: string) => new URL(href).searchParams.getAll('family');
  const styleFor = (theme: Partial<StoreTheme>) =>
    buildThemeStyleTag(
      composeStoreTheme({ template: 'qamar', look: 'qamar.atelier', theme }),
      'qamar.atelier'
    );

  it('a loadable override joins the Google Fonts link and replaces the look face', () => {
    const theme = composeStoreTheme({
      template: 'qamar',
      look: 'qamar.atelier',
      theme: { headingFont: 'Cairo', bodyFont: 'Tajawal' },
    });
    const fams = families(lookHead('qamar.atelier', theme)!.fontsHref);
    expect(fams).toContain('Cairo:wght@400;600;700');
    expect(fams).toContain('Tajawal:wght@400;500;700');
    // the look's own display + body faces are no longer painted, so not loaded
    expect(fams.some(f => f.startsWith(atelier.tokens.fonts.display))).toBe(false);
    expect(fams.some(f => f.startsWith(atelier.tokens.fonts.body))).toBe(false);
  });

  it('a non-loadable override is ignored for CSS and for the link (no unloadable family)', () => {
    const theme = { headingFont: 'Poppins', bodyFont: 'Comic Sans' };
    expect(families(lookFontsHref(atelier, theme))).toEqual(families(lookFontsHref(atelier)));
    const css = styleFor(theme);
    expect(css).toContain(`--font-display: "${atelier.tokens.fonts.display}"`);
    expect(css).toContain(`--font-body: "${atelier.tokens.fonts.body}"`);
    expect(css).not.toContain('Poppins');
    expect(css).not.toContain('Comic Sans');
  });

  it('--font-latin yields to a merchant heading font that differs from the look', () => {
    const css = styleFor({ headingFont: 'Cairo' });
    expect(css).toContain('--font-display: "Cairo", var(--font-arabic), var(--font-sans)');
    expect(css).toContain('--font-latin: "Cairo", var(--font-sans)');
  });

  it("--font-latin stays the look's Latin face when the heading font is the look's own", () => {
    const css = styleFor({ headingFont: atelier.tokens.fonts.display });
    expect(css).toContain(`--font-latin: "${atelier.tokens.fonts.latin}", var(--font-sans)`);
  });

  it('a legacy store switched with "keep" carrying an old headingFont', () => {
    // An old non-look font: ignored, the look's faces paint and load.
    const old = styleFor({ headingFont: 'Inter', bodyFont: 'Inter' });
    expect(old).toContain(`--font-display: "${atelier.tokens.fonts.display}"`);
    expect(old).toContain(`--font-latin: "${atelier.tokens.fonts.latin}"`);
    expect(old).not.toContain('Inter"');
    // An old font that happens to be loadable: the merchant's choice wins and is loaded.
    const kept = composeStoreTheme({
      template: 'qamar',
      look: 'qamar.atelier',
      theme: { headingFont: 'Amiri' },
    });
    expect(buildThemeStyleTag(kept, 'qamar.atelier')).toContain('--font-display: "Amiri"');
    expect(lookHead('qamar.atelier', kept)!.fontsHref).toContain('family=Amiri');
  });
});

describe('LOOK_VAR_PATTERNS font families', () => {
  const stack = (f: string) => `"${f}", var(--font-arabic), var(--font-sans)`;
  it('every family in LOOK_FONT_SPECS passes every font pattern', () => {
    for (const f of Object.keys(LOOK_FONT_SPECS)) {
      expect(LOOK_VAR_PATTERNS['--font-display'].test(stack(f)), f).toBe(true);
      expect(LOOK_VAR_PATTERNS['--font-body'].test(stack(f)), f).toBe(true);
      expect(LOOK_VAR_PATTERNS['--font-latin'].test(`"${f}", var(--font-sans)`), f).toBe(true);
    }
  });
  it('accepts real names with hyphens, apostrophes and spaces', () => {
    for (const f of ['M PLUS Rounded 1c', 'Zen Kaku Gothic New', "Rock 'n Roll One", 'Noto-Serif'])
      expect(LOOK_VAR_PATTERNS['--font-display'].test(stack(f)), f).toBe(true);
  });
  it('refuses CSS-breaking characters', () => {
    for (const f of ['A"; } body { x', 'A\\22', 'A;B', 'A{B', 'A}B', 'A<B', 'A)B', 'A(B'])
      expect(LOOK_VAR_PATTERNS['--font-display'].test(stack(f)), f).toBe(false);
  });
});
