/**
 * Ruling LOOKS-15: on a look store the look owns the DEFAULT product-card image ratio.
 *
 * Found by the Phase S browser check: every look renders on the `minimal` skin, whose layout
 * baseline sets `cardShape: 'square'` (and `cardAspect`) on the product carousels and
 * `productCardDefaults`. `resolveLayoutSettings` merged that baseline in as if the merchant had
 * chosen it, so `cardShapeClasses('square').aspect` beat `lookImageAspectClass` on every card
 * and no look ever showed its `--image-ratio` (qamar.atelier 3/4 rendered square). The baseline
 * now contributes no product-card shape/aspect for a registered look; a merchant's saved value
 * still wins, and a legacy store resolves exactly as before.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveLayoutSettings,
  layoutToDefinition,
  publishedDocumentAgrees,
  type StoreLayoutSettings,
} from '@force/shared';

const ratioKeys = (l: StoreLayoutSettings) => ({
  newArrivals: [l.newArrivals.cardShape, l.newArrivals.cardAspect],
  bestSellers: [l.bestSellers.cardShape, l.bestSellers.cardAspect],
  defaults: [l.productCardDefaults?.cardShape, l.productCardDefaults?.cardAspect],
});

describe('resolveLayoutSettings with a look', () => {
  it('a look store gets no product-card shape or aspect from the skin baseline', () => {
    const l = resolveLayoutSettings({}, 'minimal', 'qamar.atelier');
    expect(ratioKeys(l)).toEqual({
      newArrivals: [undefined, undefined],
      bestSellers: [undefined, undefined],
      defaults: [undefined, undefined],
    });
  });

  it('everything else in the baseline is unchanged (categories keep their shape)', () => {
    const legacy = resolveLayoutSettings({}, 'minimal');
    const look = resolveLayoutSettings({}, 'minimal', 'qamar.atelier');
    expect(look.categories).toEqual(legacy.categories);
    expect(look.hero).toEqual(legacy.hero);
    expect(look.newArrivals.cardSize).toBe(legacy.newArrivals.cardSize);
  });

  it("the merchant's saved card shape still wins on a look store", () => {
    const l = resolveLayoutSettings(
      { newArrivals: { cardShape: 'square' }, productCardDefaults: { cardShape: 'portrait' } },
      'minimal',
      'qamar.atelier'
    );
    expect(l.newArrivals.cardShape).toBe('square');
    expect(l.productCardDefaults?.cardShape).toBe('portrait');
  });

  it('a legacy store (null or unknown look) resolves byte-identically to before', () => {
    const before = resolveLayoutSettings({}, 'minimal');
    expect(resolveLayoutSettings({}, 'minimal', null)).toEqual(before);
    expect(resolveLayoutSettings({}, 'minimal', 'qamar.removed')).toEqual(before);
    expect(before.newArrivals.cardShape).toBe('square');
  });

  it('a published look document agrees with its layout only when both sides use the look', () => {
    const layout = resolveLayoutSettings({}, 'minimal', 'qamar.atelier');
    const doc = layoutToDefinition(layout);
    expect(publishedDocumentAgrees(doc, layout, 'minimal', 'qamar.atelier')).toBe(true);
  });
});
