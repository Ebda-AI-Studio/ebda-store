/**
 * Phase B3 Task 2 (Ruling B3-1): PACK_STYLES.jasmine and the Jasmine CSS block. The pack takes
 * its radius from the look (`var(--radius)`), paints only token colours, every playful detail is
 * a static-safe CSS state (its animation lives inside a no-preference media query), and the
 * Apothecary card photo sits on a paper matte so white merchant photos never read as white
 * rectangles on olive (quality bar section 9 rule 1).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { LOOKS, composeStoreTheme, themeToCssVars, contrastRatio } from '@ebda/shared';
import { getPackStyles } from '../../apps/web/src/templates/shared/pack-styles';

const root = path.resolve(__dirname, '../..');
const jasmine = LOOKS.filter(l => l.template === 'jasmine');
const css = readFileSync(path.join(root, 'apps/web/src/styles/globals.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
);
/** The Jasmine-scoped part of the stylesheet: every rule whose selector names the jasmine pack/looks. */
function jasmineCss(): string {
  const out: string[] = [];
  const re = /(@media[^{]*\{)?\s*([^{}@]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) if (/jasmine/.test(m[2])) out.push(m[0]);
  return out.join('\n');
}

describe('PACK_STYLES.jasmine', () => {
  const pack = getPackStyles('jasmine');
  it('is its own pack (not the modern fallback)', () => {
    expect(pack).not.toBe(getPackStyles('modern'));
    expect(pack.card).toContain('rounded-[var(--radius)]');
  });
  it('takes its radius from the look: Apothecary 4px(sm), Bloom 12px(lg), Clinic 8px(md) via var(--radius) only', () => {
    const radius = (id: string) => {
      const theme = composeStoreTheme({ template: 'jasmine', look: id, theme: null });
      return (themeToCssVars(theme, id) as Record<string, string>)['--radius'];
    };
    expect(radius('jasmine.apothecary')).toBe('0.25rem');
    expect(radius('jasmine.bloom')).toBe('0.75rem');
    expect(radius('jasmine.clinic')).toBe('0.5rem');
    const all = Object.values(pack).join(' ');
    expect(all).not.toMatch(/rounded-(sm|md|lg|xl|2xl|3xl|full)\b/);
  });
  it('uses only token colours and no text under 12px', () => {
    const all = Object.values(pack).join(' ');
    expect(all).not.toMatch(/\[#|rgb\(|hsl\(|\b(orange|amber|yellow|gold|brass|saffron)\b/i);
    expect(all).not.toMatch(/text-\[(\d|1[01])px\]/);
  });
  it('the card action is one >= 44px control', () => {
    expect(pack.productCardCta).toContain('min-h-[44px]');
  });
});

describe('Jasmine card paths are unchanged (Ruling B3-1: no card render path added)', () => {
  it('the jasmine skin re-exports the minimal card, grid and category components', () => {
    const src = readFileSync(path.join(root, 'apps/web/src/templates/jasmine/index.ts'), 'utf8');
    for (const c of ['ProductCard', 'ProductGrid', 'CategoryCard', 'CategoryGrid'])
      expect(src).toContain(`export { default as ${c} } from '../minimal/${c}'`);
    const own = readdirSync(path.join(root, 'apps/web/src/templates/jasmine'));
    expect(own.sort()).toEqual(['Header.tsx', 'index.ts']);
  });
});

describe('Jasmine CSS block: token-only, motion-safe', () => {
  const block = jasmineCss();
  it('there are jasmine rules for the pack and for each look', () => {
    expect(block).toMatch(/data-pack='jasmine'/);
    for (const l of jasmine) expect(block, l.id).toContain(`data-look='${l.id}'`);
  });
  it('no colour literal (hex, rgb(), hsl() with numbers, named colour) anywhere in it', () => {
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(block).not.toMatch(/\brgba?\(/);
    expect(block).not.toMatch(/\bhsla?\(\s*[\d.]/);
    expect(block).not.toMatch(/\b(orange|amber|yellow|gold|saffron|brass|peach|coral)\b/i);
  });
  it('every animation and transition sits inside a prefers-reduced-motion: no-preference block', () => {
    // strip the no-preference media blocks (balanced braces), then nothing may animate
    let rest = css;
    const open = '@media (prefers-reduced-motion: no-preference) {';
    for (let i = rest.indexOf(open); i !== -1; i = rest.indexOf(open)) {
      let depth = 0;
      let j = i + open.length - 1;
      for (; j < rest.length; j++) {
        if (rest[j] === '{') depth++;
        if (rest[j] === '}' && --depth === 0) break;
      }
      rest = rest.slice(0, i) + rest.slice(j + 1);
    }
    const outside = [...rest.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].filter(
      ([, sel, body]) => /jasmine/.test(sel) && /\b(animation|transition)\b/.test(body)
    );
    expect(outside.map(([, sel]) => sel.trim())).toEqual([]);
    // and the details exist: the three keyframes / transitions are in the motion-gated part
    expect(css).toMatch(/@keyframes jasmine-drop/);
    expect(css).toMatch(/@keyframes jasmine-pop/);
  });
  it('the playful details resolve to a static end state under reduced motion', () => {
    // Bloom: the page-wash tint is applied by :has() with no motion condition
    const flat = css.replace(/\s+/g, ' ');
    expect(flat).toMatch(
      /\[data-look='jasmine\.bloom'\] main:has\( ?\[data-option-group\] button\[aria-pressed='true'\] \[data-swatch-hex\] ?\) \{[^}]*color-mix/
    );
    // Clinic: the tick is shown by data-done alone
    expect(css).toMatch(
      /\[data-part='step'\]\[data-done='true'\] \[data-part='step-tick'\]\s*\{\s*opacity: 1/
    );
  });
});

describe('Apothecary: merchant white-background photos sit on a paper matte (quality bar 9.1)', () => {
  it('the card photo and tile get the page ink as a matte and multiply into it, but never inside an inverse band', () => {
    const flat = css.replace(/\s+/g, ' ');
    const band = "\\:not\\(\\[style\\*='--bg-page'\\] \\*\\)";
    expect(flat).toMatch(
      new RegExp(
        `\\[data-look='jasmine\\.apothecary'\\] \\[data-part='card-image'\\]${band}, \\[data-look='jasmine\\.apothecary'\\] \\[data-part='tile'\\]${band} \\{ background-color: hsl\\(var\\(--foreground\\)\\)`
      )
    );
    expect(flat).toMatch(
      new RegExp(
        `jasmine\\.apothecary'\\] \\[data-part='card-image'\\]${band} img[^{]*\\{ mix-blend-mode: multiply`
      )
    );
  });
  it('the inverse band is exactly what sets --bg-page inline (so the exclusion matches the real band, not a guess)', () => {
    const src = readFileSync(
      path.join(root, 'apps/web/src/templates/shared/section-bg.ts'),
      'utf8'
    );
    expect(src).toMatch(/'--bg-page': ink/);
    // both band producers go through inverseBandStyle: the section band and the dark-look listing band
    expect(src).toMatch(/return inverseBandStyle\(theme\)/g);
  });
  it('the matte is clearly separate from the page (rendered-band pair): ink vs page >= 3:1', () => {
    const t = jasmine.find(l => l.id === 'jasmine.apothecary')!.tokens;
    expect(contrastRatio(t.page, t.ink)).toBeGreaterThanOrEqual(3);
  });
  it('the chip pair resolves to the primary pair (one accent), only on Apothecary', () => {
    expect(css).toMatch(
      /\[data-look='jasmine\.apothecary'\]\s*\{\s*--chip-bg: var\(--primary\);\s*--chip-fg: var\(--primary-foreground\)/
    );
    const others = [...css.matchAll(/\[data-look='([^']+)'\]\s*\{[^}]*--chip-bg/g)].map(m => m[1]);
    expect(others.sort()).toEqual(['jasmine.apothecary', 'souq.night']);
  });
});
