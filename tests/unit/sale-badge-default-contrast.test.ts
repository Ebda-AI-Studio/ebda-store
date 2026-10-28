/**
 * K-01, contrast half (Qamar taste audit 2026-10-15, quality-bar § 3): the sale
 * badge a merchant never coloured must read at AA. The old default was
 * `hsl(var(--destructive))` under white text: #EF4444 on white measures 3.76:1.
 *
 * The badge colour is used two ways, and each has its own default:
 *  - fill (7 card paths: a chip with `text-white` on `backgroundColor`) →
 *    `DEFAULT_DISCOUNT_BADGE_FILL`, measured against white and the
 *    destructive-foreground token;
 *  - text (the minimal pack prints the label inline in that colour) →
 *    the store's destructive ink, measured against the page and card fallbacks.
 * A CSS var default is resolved through the `:root` block of globals.css, the
 * value a store with no theme override paints. Look-driven colours are W2 #4.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { contrastRatio } from '@ebda/shared';
import {
  getDiscountBadgeColor,
  DEFAULT_DISCOUNT_BADGE_FILL,
} from '../../apps/web/src/templates/shared/discount-badge';

const ROOT = join(__dirname, '../..');
const WEB = join(ROOT, 'apps/web/src');
const css = readFileSync(join(WEB, 'styles/globals.css'), 'utf8');
const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));

function rootVar(name: string): string {
  const m = rootBlock.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`--${name} not in :root`);
  return `hsl(${m[1].trim()})`;
}

/** `#hex` stays; `hsl(var(--x))` becomes the :root value of --x. */
function paint(value: string): string {
  const v = value.match(/^hsl\(var\(--([a-z-]+)\)\)$/);
  return v ? rootVar(v[1]) : value;
}

describe('K-01: the default sale badge reads at AA', () => {
  it('fill: white chip text on the default fill is >= 4.5:1', () => {
    const fill = paint(getDiscountBadgeColor(undefined));
    expect(contrastRatio(fill, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(fill, rootVar('destructive-foreground'))).toBeGreaterThanOrEqual(4.5);
  });

  it('fill: no theme / no merchant colour both land on the AA fill', () => {
    expect(getDiscountBadgeColor(undefined, undefined)).toBe(DEFAULT_DISCOUNT_BADGE_FILL);
    expect(getDiscountBadgeColor('', undefined, 'fill')).toBe(DEFAULT_DISCOUNT_BADGE_FILL);
  });

  it('text: the inline label colour is >= 4.5:1 on the page and card fallbacks', () => {
    const ink = paint(getDiscountBadgeColor(undefined, undefined, 'text'));
    expect(contrastRatio(rootVar('background'), ink)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(rootVar('card'), ink)).toBeGreaterThanOrEqual(4.5);
  });

  it('a merchant colour still wins over the default', () => {
    expect(getDiscountBadgeColor('#123456', {} as never)).toBe('#123456');
  });

  // Every card path asks for the default that matches how it paints the colour.
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap(n => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.tsx$/.test(n) && !/\.test\./.test(n) ? [p] : [];
    });
  const users = walk(WEB).filter(f => readFileSync(f, 'utf8').includes('getDiscountBadgeColor('));

  it('finds every card path that reads the badge colour', () => {
    // StorefrontProductCard, base/ProductCard, ProductCarousel, ProductListItem
    expect(users.length).toBeGreaterThanOrEqual(4);
  });

  it('a label painted in the colour asks for the text default; a chip asks for the fill', () => {
    const bad = users.flatMap(f => {
      const src = readFileSync(f, 'utf8');
      const call = src.match(/getDiscountBadgeColor\(([\s\S]*?)\)/)?.[1] ?? '';
      const asText = /'text'/.test(call);
      const out: string[] = [];
      if (/color:\s*discountBadgeColor/.test(src.replace(/backgroundColor:/g, 'bg:')) && !asText)
        out.push(`${relative(ROOT, f)}: label in the badge colour without 'text'`);
      if (/backgroundColor:\s*discountBadgeColor/.test(src) && asText)
        out.push(`${relative(ROOT, f)}: chip fill asked for the text default`);
      return out;
    });
    expect(bad).toEqual([]);
  });
});
