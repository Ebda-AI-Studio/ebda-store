/**
 * Quality bar K-05 (Task 8 fix round 1, Ruling B1-43): a storefront form field draws its boundary
 * with `--input`, never the hairline `--border`; every look composes `--input` from its muted ink,
 * so field boundaries are >= 3:1 on the page and on the surface; every skin defines
 * `inputColor === borderColor`, so a store without a look renders its fields exactly as before.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  LOOKS,
  contrastRatio,
  boundaryColorFloor,
  composeStoreTheme,
  getTemplateTheme,
  deriveCoreBrandTokens,
  TEMPLATE_THEMES,
  type TemplateId,
} from '@ebda/shared';

const root = path.resolve(__dirname, '../..');
const hsl = (triplet: string) => `hsl(${triplet})`;

describe('every look: input boundary >= 3:1 (K-05)', () => {
  for (const look of LOOKS)
    it(look.id, () => {
      const theme = composeStoreTheme({ template: look.skin, look: look.id });
      expect(contrastRatio(look.tokens.page, hsl(theme.inputColor))).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(look.tokens.surface, hsl(theme.inputColor))).toBeGreaterThanOrEqual(3);
    });
});

describe('a store without a look: --input equals --border on every skin (fields unchanged)', () => {
  for (const id of Object.keys(TEMPLATE_THEMES) as TemplateId[])
    it(id, () => {
      const t = getTemplateTheme(id);
      expect(t.inputColor).toBe(t.borderColor);
    });
});

describe('stores with saved colours keep their field colour (N1)', () => {
  it('both palette writers: an applied palette yields inputColor === borderColor', () => {
    for (const seeds of [
      { primary: '#1F4E54' }, // SmartPaletteModal (legacy mode, light)
      { primary: '#1F4E54', neutral: '#111111' }, // legacy mode, dark neutral
      { primary: '#9E5E5E', secondary: '#1F4E54' }, // Branding editor (new mode)
    ]) {
      const t = deriveCoreBrandTokens(seeds);
      expect(t.inputColor, JSON.stringify(seeds)).toBe(t.borderColor);
    }
  });

  it('no look + a saved custom border colour: fields draw in that border, floored to 3:1 (B1-90)', () => {
    for (const id of Object.keys(TEMPLATE_THEMES) as TemplateId[]) {
      const t = composeStoreTheme({ template: id, theme: { borderColor: '12 40% 30%' } });
      // the saved border's hue and saturation; lightness only moves if it reads under 3:1
      expect(t.inputColor, id).toBe(boundaryColorFloor('12 40% 30%', t.backgroundColor));
      expect(t.inputColor.startsWith('12 40% '), id).toBe(true);
      expect(t.borderColor, id).toBe('12 40% 30%');
    }
    // an unregistered look id renders as legacy too
    expect(
      composeStoreTheme({
        template: 'qamar',
        look: 'qamar.removed',
        theme: { borderColor: '1 2% 3%' },
      }).inputColor
    ).toBe(boundaryColorFloor('1 2% 3%', '0 0% 100%'));
  });

  it('an explicitly saved input colour wins; a look store keeps its muted input', () => {
    expect(
      composeStoreTheme({
        template: 'qamar',
        theme: { borderColor: '12 40% 30%', inputColor: '0 0% 40%' },
      }).inputColor
    ).toBe('0 0% 40%');
    const v = LOOKS.find(l => l.id === 'qamar.vitrine')!;
    const t = composeStoreTheme({
      template: 'qamar',
      look: v.id,
      theme: { borderColor: '45 60% 70%' },
    });
    expect(t.inputColor).not.toBe('45 60% 70%');
    expect(contrastRatio(v.tokens.page, hsl(t.inputColor))).toBeGreaterThanOrEqual(3);
  });
});

/** className text of every <input>, <textarea>, <select> opening tag in a .tsx file. */
function fieldTags(src: string): { line: number; tag: string }[] {
  const out: { line: number; tag: string }[] = [];
  for (const m of src.matchAll(/<(input|textarea|select)\b/g)) {
    let i = m.index! + m[0].length;
    let depth = 0;
    for (; i < src.length && i - m.index! < 4000; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    out.push({ line: src.slice(0, m.index).split('\n').length, tag: src.slice(m.index, i + 1) });
  }
  return out;
}

describe('no storefront form field draws its boundary with the hairline', () => {
  it('apps/web/src: <input|textarea|select> never carries border-border', () => {
    const files = execFileSync('git', ['ls-files', 'apps/web/src'], { cwd: root })
      .toString()
      .split('\n')
      .filter(f => f.endsWith('.tsx'));
    const offenders: string[] = [];
    for (const f of files)
      for (const { line, tag } of fieldTags(readFileSync(path.join(root, f), 'utf8')))
        if (/(?<![\w-])border-border(?![\w-])/.test(tag)) offenders.push(`${f}:${line}`);
    expect(offenders).toEqual([]);
  });

  it('apps/web/src: a field with a border width always names its colour (no default hairline)', () => {
    const files = execFileSync('git', ['ls-files', 'apps/web/src'], { cwd: root })
      .toString()
      .split('\n')
      .filter(f => f.endsWith('.tsx'));
    const offenders: string[] = [];
    for (const f of files)
      for (const { line, tag } of fieldTags(readFileSync(path.join(root, f), 'utf8'))) {
        const cls = [...tag.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
          .map(x => x[1] ?? x[2])
          .join(' ');
        const width = /(?<![\w:-])border(-[trblxy])?(?![\w-])/.test(cls);
        const colour = /(?<![\w:-])border(-[trblxy])?-(?!\d|0\b|none|solid|dashed)[a-z]/.test(cls);
        if (width && !colour) offenders.push(`${f}:${line}`);
      }
    expect(offenders).toEqual([]);
  });

  it('field component classes and the checkout combobox use --input', () => {
    const css = readFileSync(path.join(root, 'apps/web/src/styles/globals.css'), 'utf8');
    for (const c of ['search-box', 'quantity-selector', 'form-input'])
      expect(css, c).toMatch(new RegExp(`\\.${c} \\{\\s*@apply[^;]*\\bborder border-input\\b`));
    const combo = readFileSync(
      path.join(root, 'apps/web/src/app/checkout/_components/GovernorateAreaSelect.tsx'),
      'utf8'
    );
    expect(combo).toContain("'border-input focus-within:border-primary");
  });

  it('the scanner sees a field (mutation guard)', () => {
    expect(
      fieldTags('<input onChange={e => go(e)} className="border border-border" />')[0].tag
    ).toContain('border-border');
  });
});

// Taste gate VT-05 (W2a): a decorative `line` token below 3:1 (Vitrine's champagne is 1.74:1)
// never draws an interactive boundary. Option chips, the PDP stepper, the filter trigger and
// panel frame and the PLP view/density toggles read --input like the fields above.
describe('interactive control boundaries use --input, never the hairline (VT-05)', () => {
  const read = (f: string) => readFileSync(path.join(root, 'apps/web/src', f), 'utf8');
  it('variant option chips (available and unavailable)', () => {
    const v = read('components/VariantSelector.tsx');
    expect(v).not.toMatch(/'[^']*border-border[^']*line-through/);
    expect(v).not.toMatch(/\? 'border-border /);
    expect(v.match(/border-input/g)?.length).toBeGreaterThanOrEqual(4);
  });
  it('filter trigger and the desktop filter panel frame', () => {
    const f = read('app/products/ProductsFilterSidebar.tsx');
    expect(f).not.toContain('border-border');
    // PREMIUM-20 (audit 2026-11-03 #9): the PANEL frame is a container, not a control, so it is a
    // hairline of the panel's own ink, not the --input boundary. The CONTROLS inside it (chips,
    // slider thumbs, selects) keep real boundaries: chips border-input-class, thumbs border-primary.
    expect(f).toContain('lg:border lg:border-[hsl(var(--filter-fg)/0.12)]');
    expect(f).toContain('border-input'); // the mobile trigger + selects still read --input
  });
  it('the PLP view and density toggles and the PDP quantity stepper', () => {
    expect(read('app/products/ProductsClient.tsx')).toContain(
      'className="flex rounded-[var(--radius)] border border-input"'
    );
    expect(read('app/products/ProductsClient.tsx')).toContain(
      'rounded-lg border border-input bg-background p-1 sm:flex'
    );
    expect(read('app/products/[slug]/ProductDetailClient.tsx')).toContain(
      '<div className="flex items-center rounded-lg border border-input">'
    );
  });
});
