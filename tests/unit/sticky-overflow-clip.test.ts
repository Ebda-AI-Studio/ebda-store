import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #124: `overflow-x: hidden` on html/body makes <body> a scroll container, which inerts every
// `position: sticky` descendant. `clip` clips the same overflow without one.
const css = readFileSync('apps/web/src/styles/globals.css', 'utf8');
const layout = readFileSync('apps/web/src/app/layout.tsx', 'utf8');

describe('sticky stays live under the horizontal overflow guard (#124)', () => {
  it('html and body use overflow-x: clip where supported', () => {
    expect(css).toMatch(/@supports \(overflow: clip\) \{\s*html,\s*body \{\s*overflow-x: clip;/);
  });
  it('the body class list no longer carries overflow-x-hidden', () => {
    expect(layout).not.toMatch(/antialiased[^`]*overflow-x-hidden/);
  });
  it('the filter rail panel (not an inner div) is the sticky element', () => {
    const src = readFileSync('apps/web/src/app/products/ProductsFilterSidebar.tsx', 'utf8');
    expect(src).toMatch(/lg:sticky lg:top-\[calc\(var\(--header-h,0px\)\+1rem\)\]/);
    expect(src).not.toMatch(/id="products-filter-panel" className="[^"]*sticky/);
  });
});
