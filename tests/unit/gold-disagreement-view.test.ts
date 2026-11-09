/** GOLD-DISAGREE-MERCHANT-1: what getState tells the owner about a feed disagreement. */
import { describe, it, expect } from 'vitest';
import { disagreementFrom } from '../../apps/api/src/services/gold-rate/gold-rate.service';

const ref = {
  disagree: {
    diffBps: 313,
    primary24k: 713_800,
    fallback24k: 736_100,
    fallbackRates: { 24: 736_100, 21: 644_088, 18: 552_075 },
  },
};

describe('disagreementFrom', () => {
  it('reads both feed values, the gap and the candidates from the pending rows', () => {
    const d = disagreementFrom([
      { karat: 24, ratePerGram: 713_800, feedReference: ref },
      { karat: 21, ratePerGram: 624_575, feedReference: ref },
    ]);
    expect(d).toMatchObject({
      diffBps: 313,
      primary24k: 713_800,
      fallback24k: 736_100,
      primaryRates: { 24: 713_800, 21: 624_575 },
      fallbackRates: { 24: 736_100, 21: 644_088, 18: 552_075 },
    });
  });
  it('is null for a plain jump-gate pending rate and for a malformed reference', () => {
    expect(
      disagreementFrom([{ karat: 21, ratePerGram: 1, feedReference: { source: 'primary' } }])
    ).toBeNull();
    expect(disagreementFrom([{ karat: 21, ratePerGram: 1, feedReference: null }])).toBeNull();
    expect(
      disagreementFrom([
        {
          karat: 21,
          ratePerGram: 1,
          feedReference: { disagree: { ...ref.disagree, fallbackRates: { 24: 1 } } },
        },
      ])
    ).toBeNull();
  });
});
