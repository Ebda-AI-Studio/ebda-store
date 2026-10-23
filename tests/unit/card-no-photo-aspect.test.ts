import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Ahmad 2026-10-23: a card without a photo keeps the SAME aspect as the grid's photo cards (a soft
// tile with the mark), so prices line up across the row. The short `aspect-[2/1]` placeholder is gone.
describe('no-photo product card aspect', () => {
  const src = readFileSync('apps/web/src/templates/shared/StorefrontProductCard.tsx', 'utf8');
  it('does not override the aspect when there is no image', () => {
    expect(src).not.toMatch(/!aspect-\[2\/1\]/);
    expect(src).not.toMatch(/!img && getLook\(store\.look\) \?/);
  });
  it('still renders the placeholder tile inside the shared image box', () => {
    expect(src).toContain('data-part="card-no-photo"');
  });
});
