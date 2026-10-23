import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// PLP-2: `auto-fit` + a 20rem cap counts columns by the CAP, so a full catalogue beside the filter rail
// got 2 centred 320px columns and a ~180px dead zone at 1280. A real catalogue now fills the row.
describe('PLP grid at lg+', () => {
  const src = readFileSync('apps/web/src/app/products/ProductsClient.tsx', 'utf8');
  it('fills the row with auto-fill/1fr for a real catalogue', () => {
    expect(src).toContain('repeat(auto-fill,minmax(12.5rem,1fr))');
  });
  it('keeps the centred 20rem cap only for 1-3 products (B4-21)', () => {
    expect(src).toMatch(/products\.length > 0 && products\.length <= 3/);
    expect(src).toContain('repeat(auto-fit,minmax(11.5rem,20rem))');
  });
});

// PLP-3: below lg the sidebar column is a flex column, so the grid/list toggle stretched into a
// full-width bordered bar with two small icons and a dead strip (820px tablet).
describe('PLP view toggle', () => {
  it('hugs its buttons instead of stretching', () => {
    const src = readFileSync('apps/web/src/app/products/ProductsClient.tsx', 'utf8');
    expect(src).toMatch(/hidden w-fit items-center gap-1 self-start rounded-lg border/);
  });
});
