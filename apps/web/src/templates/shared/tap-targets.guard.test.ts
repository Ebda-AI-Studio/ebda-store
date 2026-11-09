import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** Audit 2026-11-03 (b, dahab + All): interactive controls are 44px targets. Source guard for the
 * controls the audit measured under 32px (Dahab drawer/PDP steppers, slide dots, cart remove, list-row actions). */
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const lines = (src: string, needle: RegExp) => src.split('\n').filter(l => needle.test(l));

describe('44px tap targets', () => {
  it('dahab cart drawer steppers are 44px', () => {
    const l = lines(
      read('../dahab/CartDrawer.tsx'),
      /flex h-\d+ w-\d+ items-center justify-center text-foreground\/80/
    );
    expect(l.length).toBe(2);
    for (const x of l) expect(x).toContain('h-11 w-11');
  });
  it('dahab PDP steppers keep 44px wide on phones', () => {
    const l = lines(read('../dahab/ProductDetail.tsx'), /flex h-12 w-11 items-center/);
    expect(l.length).toBe(2);
    for (const x of l) expect(x).not.toContain('max-lg:w-9');
  });
  it('dahab hero slide dots are 44px wide', () => {
    expect(read('../dahab/Hero.tsx')).toContain('pointer-events-auto flex h-11 w-11 items-center');
  });
  it('cart remove button and list-row actions are not under 44px', () => {
    expect(read('../../app/cart/CartClient.tsx')).not.toMatch(
      /flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground/
    );
    expect(read('../../app/products/ProductListItem.tsx')).not.toMatch(
      /flex h-10 (w-10 )?items-center/
    );
  });
});
