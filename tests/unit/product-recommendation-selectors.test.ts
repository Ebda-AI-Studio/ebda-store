import { describe, it, expect } from 'vitest';
import {
  selectCrossSell,
  selectMergedRecommendations,
} from '../../apps/web/src/hooks/useProductRecommendations';

const p = (id: string) => ({ id, name: id, slug: id, price: 1, images: [] });

describe('selectCrossSell — "Frequently bought together"', () => {
  it('returns the cross-sell slot', () => {
    expect(selectCrossSell({ crossSell: [p('a'), p('b')] }).map(x => x.id)).toEqual(['a', 'b']);
  });

  it('ignores the other slots entirely', () => {
    expect(selectCrossSell({ upsell: [p('u')], alsoLike: [p('l')] })).toEqual([]);
  });

  it('treats missing or empty cross-sell as nothing to recommend', () => {
    expect(selectCrossSell({})).toEqual([]);
    expect(selectCrossSell({ crossSell: [] })).toEqual([]);
  });
});

describe('selectMergedRecommendations — "You might also like"', () => {
  it('merges in priority order: upsell, then crossSell, then alsoLike', () => {
    const out = selectMergedRecommendations({
      upsell: [p('u')],
      crossSell: [p('c')],
      alsoLike: [p('l')],
    });
    expect(out.map(x => x.id)).toEqual(['u', 'c', 'l']);
  });

  it('dedupes by id, keeping the highest-priority occurrence', () => {
    // A product can legitimately appear in more than one slot.
    const out = selectMergedRecommendations({
      upsell: [p('dup')],
      crossSell: [p('dup'), p('c')],
      alsoLike: [p('dup')],
    });
    expect(out.map(x => x.id)).toEqual(['dup', 'c']);
  });

  it('handles every slot being absent', () => {
    expect(selectMergedRecommendations({})).toEqual([]);
  });

  it('still surfaces crossSell when it carries the AI recommendations', () => {
    // recommendation.service.ts orders manual > AI > FBT, and AI results land in
    // the crossSell slot when no manual relations exist — so crossSell must not
    // be skipped just because upsell is empty.
    expect(selectMergedRecommendations({ crossSell: [p('ai')] }).map(x => x.id)).toEqual(['ai']);
  });
});
