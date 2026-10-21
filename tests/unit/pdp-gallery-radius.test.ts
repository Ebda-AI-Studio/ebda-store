/**
 * Ruling B1-34 (re-review P2): the PDP gallery follows the store's corner radius on every skin.
 * The shared PDP hard-coded `rounded-2xl`, so a radius:none look (Atelier) and a merchant's
 * "corner radius" setting silently did nothing there. Dahab's PDP already used var(--radius).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const web = path.resolve(__dirname, '../../apps/web/src');
const read = (f: string) => readFileSync(path.join(web, f), 'utf8');

describe('PDP gallery radius = var(--radius)', () => {
  const pdp = read('app/products/[slug]/ProductDetailClient.tsx');
  it('the main gallery frame and its skeleton use the store radius', () => {
    expect(pdp).toMatch(/max-w-\[600px\] overflow-hidden rounded-\[var\(--radius\)\]/);
    expect(pdp).toMatch(/aspect-square rounded-\[var\(--radius\)\] bg-muted/);
  });
  it('no fixed large radius is left on the gallery', () => {
    const gallery = pdp.slice(
      pdp.indexOf('pdpAspectClass} mx-auto'),
      pdp.indexOf('pdpAspectClass} mx-auto') + 400
    );
    expect(gallery).not.toMatch(/rounded-(xl|2xl|3xl)/);
  });
  it('Dahab PDP gallery keeps var(--radius)', () => {
    expect(read('templates/dahab/ProductDetail.tsx')).toMatch(
      /aspect-\[4\/5\] flex-1 cursor-zoom-in overflow-hidden rounded-\[var\(--radius\)\]/
    );
  });
});
