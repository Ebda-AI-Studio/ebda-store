import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// axe link-name (serious): the cart thumbnail link is empty when a product has no photo. The name
// link beside it already names the product, so the empty duplicate is hidden from AT and the tab order.
describe('cart thumbnail link without a photo', () => {
  for (const t of ['minimal', 'bold', 'dahab', 'elegant', 'classic', 'modern']) {
    it(`${t} hides the empty thumb link`, () => {
      const src = readFileSync(`apps/web/src/templates/${t}/CartTable.tsx`, 'utf8');
      expect(src).toMatch(
        /\{\.\.\.\(item\.image \? \{\} : \{ 'aria-hidden': true, tabIndex: -1 \}\)\}/
      );
    });
  }
});
