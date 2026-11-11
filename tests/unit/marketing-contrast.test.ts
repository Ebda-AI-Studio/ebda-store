/**
 * WCAG contrast of the marketing site's colour tokens (globals.css), computed from the real
 * file and BRAND, so a palette edit that drops body text below AA fails here (MKT-1 light canvas).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND } from '../../packages/shared/src/brand';

// globals.css holds :root; chrome.css holds .band-dark (the generated site-footer block, the one that wins the cascade).
const css = ['globals.css', 'chrome.css']
  .map(f => readFileSync(path.resolve(__dirname, '../../apps/marketing/src/app', f), 'utf8'))
  .join('\n');

function block(selector: string): Record<string, string> {
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')} \\{([^}]*)\\}`));
  if (!m) throw new Error(`no ${selector} block`);
  return Object.fromEntries([...m[1].matchAll(/--([\w-]+):\s*([^;]+);/g)].map(x => [x[1], x[2]]));
}
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const lum = (hex: string) => {
  const [r, g, b] = rgb(hex).map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** `var(--x)` / `color-mix(in srgb, var(--gold) N%, #000)` resolved to a hex. */
function resolve(v: string, own: Record<string, string>): string {
  const t = v.trim();
  if (t.startsWith('#')) return t;
  const mix = t.match(/^color-mix\(in srgb, var\(--(\w+)\) (\d+)%, #000\)$/);
  if (mix) {
    const base = resolve(`var(--${mix[1]})`, own);
    return (
      '#' +
      rgb(base)
        .map(c =>
          Math.round((c * Number(mix[2])) / 100)
            .toString(16)
            .padStart(2, '0')
        )
        .join('')
    );
  }
  const ref = t.match(/^var\(--([\w-]+)\)$/);
  if (!ref) throw new Error(`cannot resolve ${v}`);
  const brand = { night: BRAND.colors.night, gold: BRAND.colors.gold, lift: BRAND.colors.lift };
  return ref[1] in own ? resolve(own[ref[1]], own) : brand[ref[1] as keyof typeof brand];
}

describe('marketing colour tokens', () => {
  const light = block(':root');
  const dark = block('.band-dark');
  const L = (n: string) => resolve(light[n], light);
  const D = (n: string) => resolve(dark[n], dark);

  it('the light canvas is a true neutral off-white (chroma 0), never a warm paper', () => {
    const [r, g, b] = rgb(L('canvas'));
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(lum(L('canvas'))).toBeGreaterThan(0.9);
  });

  it('light: body, muted and gold-ink text pass AA (4.5:1) on canvas, panel and raised surfaces', () => {
    for (const bg of ['canvas', 'panel', 'raise'])
      for (const fg of ['fg', 'muted', 'accent-text'])
        expect(ratio(L(fg), L(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it('light: borders that define a control reach 3:1 (non-text, WCAG 1.4.11)', () => {
    expect(ratio(L('line-strong'), L('canvas'))).toBeGreaterThanOrEqual(3);
  });

  it('dark band: text and lift-gold text pass AA on night, panel and raised', () => {
    for (const bg of ['canvas', 'panel', 'raise'])
      for (const fg of ['fg', 'muted', 'accent-text'])
        expect(ratio(D(fg), D(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    expect(ratio(D('line-strong'), D('canvas'))).toBeGreaterThanOrEqual(3);
  });

  it('the primary button (night text on brand gold) passes AA', () => {
    expect(ratio(BRAND.colors.night, BRAND.colors.gold)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(BRAND.colors.night, BRAND.colors.lift)).toBeGreaterThanOrEqual(4.5);
  });

  it('on the light canvas the raw brand gold is never used as text (it is 2.96:1)', () => {
    expect(ratio(BRAND.colors.gold, L('canvas'))).toBeLessThan(4.5);
    expect(light['accent-text']).toContain('color-mix');
  });
});

describe('looks template tabs (phone width)', () => {
  it('keep all five reachable: a visible grid, never a hidden horizontal scroller', () => {
    const phone = css.match(/@media \(max-width: 640px\) \{[\s\S]*?\n\}\n/)![0];
    const tabs = phone.match(/\.looks-tabs \{[^}]*\}/)![0];
    expect(tabs).toContain('grid-template-columns: repeat(3');
    expect(tabs).not.toMatch(/nowrap|overflow/);
  });
});
