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

// PLP-4 / hero edge: the stacked hero copy (below xl) must share the page container's text edge
// (`px-4 sm:px-6 lg:px-8`), not its own `px-5 sm:px-8` (4px off at 390, 8px off at 820).
describe('hero copy edge', () => {
  it('stacked copy uses the container padding', () => {
    const src = readFileSync('apps/web/src/templates/shared/HeroBanner.tsx', 'utf8');
    expect(src).toContain("'px-4 sm:px-6 lg:px-8'");
    expect(src).not.toContain("'px-5 sm:px-8'");
  });
});

// PDP price row: the instalment note used to share the price's flex row and wrap into a 2-line
// fragment beside the price at 390; the row wraps and the note takes its own line below sm.
describe('PDP price row', () => {
  it('wraps and gives the instalment note its own line on phones', () => {
    const pdp = readFileSync('apps/web/src/app/products/[slug]/ProductDetailClient.tsx', 'utf8');
    expect(pdp).toContain('mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1');
    const line = readFileSync('apps/web/src/components/commerce/InstalmentLine.tsx', 'utf8');
    expect(line).toContain('w-full max-w-full text-balance');
    expect(line).toContain('sm:w-auto');
  });
});
