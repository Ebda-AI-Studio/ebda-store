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

  it('no look + a saved custom border colour: fields draw in that border (as before the sweep)', () => {
    for (const id of Object.keys(TEMPLATE_THEMES) as TemplateId[]) {
      const t = composeStoreTheme({ template: id, theme: { borderColor: '12 40% 30%' } });
      expect(t.inputColor, id).toBe('12 40% 30%');
      expect(t.borderColor, id).toBe('12 40% 30%');
    }
    // an unregistered look id renders as legacy too
    expect(
      composeStoreTheme({
        template: 'minimal',
        look: 'qamar.removed',
        theme: { borderColor: '1 2% 3%' },
      }).inputColor
    ).toBe('1 2% 3%');
  });

  it('an explicitly saved input colour wins; a look store keeps its muted input', () => {
    expect(
      composeStoreTheme({
        template: 'minimal',
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
