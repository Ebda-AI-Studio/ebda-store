/**
 * The added-to-cart state and the quantity badge read at AA in BOTH themes:
 *  - the added state is the success tint (success at 20% over the page) with `success-ink`
 *    text and icon: text >= 4.5:1, icon (currentColor = the same ink) >= 3:1;
 *  - the count badge is `destructive-ink` on the page background: text >= 4.5:1.
 * The old fills (white on `success` 3.35 light / 2.75 dark, white on `destructive` 3.59) failed.
 * Values come from the real token blocks in globals.css; the classes are pinned in the source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastRatio } from '@ebda/shared';

const ROOT = join(__dirname, '../..');
const css = readFileSync(join(ROOT, 'apps/web/src/styles/globals.css'), 'utf8');
const src = readFileSync(join(ROOT, 'packages/ui/src/components/AddToCartButton.tsx'), 'utf8');

function block(open: string): string {
  const at = css.indexOf(open);
  return css.slice(at, css.indexOf('\n  }', at));
}
const THEMES = { light: block(':root {'), dark: block('.dark {') } as const;

function token(theme: keyof typeof THEMES, name: string): [number, number, number] {
  const m = THEMES[theme].match(new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%;`));
  if (!m) throw new Error(`--${name} missing in ${theme}`);
  return [+m[1], +m[2], +m[3]];
}
function rgb([h, s, l]: [number, number, number]): [number, number, number] {
  const sat = s / 100;
  const li = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(li, 1 - li);
  const f = (n: number) => li - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
const hex = (c: number[]) => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
const over = (fg: number[], bg: number[], alpha: number) =>
  fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));

describe('added-to-cart state + count badge contrast (light and dark)', () => {
  it('the source uses the tint + ink pair, not a white-on-fill', () => {
    expect(src).toContain('bg-success/20 text-success-ink');
    expect(src).toContain('bg-background text-destructive-ink');
    expect(src).not.toMatch(/text-success-foreground|text-destructive-foreground|text-white/);
  });

  for (const theme of ['light', 'dark'] as const) {
    const bg = rgb(token(theme, 'background'));

    it(`${theme}: success-ink on the success tint >= 4.5 (text) and >= 3 (icon)`, () => {
      const tint = over(rgb(token(theme, 'success')), bg, 0.2);
      const ratio = contrastRatio(hex(tint), hex(rgb(token(theme, 'success-ink'))));
      expect(ratio).toBeGreaterThanOrEqual(4.5);
      expect(ratio).toBeGreaterThanOrEqual(3);
    });

    it(`${theme}: destructive-ink on the page >= 4.5 (count badge)`, () => {
      expect(
        contrastRatio(hex(bg), hex(rgb(token(theme, 'destructive-ink'))))
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});
