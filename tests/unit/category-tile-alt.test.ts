/**
 * a11y P2-4 (independent a11y audit): a category tile's image sat inside a link
 * whose visible text is the same name (axe image-redundant-alt), so a screen
 * reader read "عبايات عبايات". The image is decorative whenever the label shows;
 * it carries the name only when the merchant hides the label.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const T = join(__dirname, '../../apps/web/src/templates');
const files = [
  ...readdirSync(T)
    .map(d => join(d, 'CategoryCard.tsx'))
    .filter(f => existsSync(join(T, f))),
  'shared/CategoryStrip.tsx',
];

describe('category tile images do not repeat the visible label', () => {
  it.each(files)('%s', f => {
    const src = readFileSync(join(T, f), 'utf8');
    const alts = [...src.matchAll(/\balt=(\{[^}]*\}|"[^"]*")/g)].map(m => m[1]);
    expect(alts.length).toBeGreaterThan(0);
    for (const a of alts) {
      // Allowed: alt="" or a name gated on the label being hidden.
      expect(a === '""' || /showLabel === false \?/.test(a)).toBe(true);
    }
  });
});
