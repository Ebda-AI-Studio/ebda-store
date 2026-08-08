import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  computeCostMicros,
  hasAnyRateConfigured,
  __resetRateCacheForTests,
} from '../../apps/api/src/lib/ai-pricing';

// Audit finding 25.3: AI spend was recorded in tokens and never in currency,
// so nothing could divide cost by the revenue it served.
//
// The load-bearing property here is that `null` (no rate configured) and `0`
// (genuinely free — a cached hit) are DIFFERENT. Collapsing them makes an
// unpriced deployment look free, which is the failure mode this column exists
// to prevent, and people act on margin numbers.
describe('computeCostMicros', () => {
  const original = process.env.AI_MODEL_RATES;

  beforeEach(() => {
    __resetRateCacheForTests();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.AI_MODEL_RATES;
    else process.env.AI_MODEL_RATES = original;
    __resetRateCacheForTests();
  });

  describe('unpriced is null, never zero', () => {
    it('returns null when no rates are configured at all', () => {
      delete process.env.AI_MODEL_RATES;
      expect(computeCostMicros('gemini-flash-lite-latest', 1000, 1000)).toBeNull();
    });

    it('returns null for a model absent from the rate table', () => {
      process.env.AI_MODEL_RATES = JSON.stringify({ 'some-other-model': { in: 1, out: 1 } });
      expect(computeCostMicros('gemini-flash-lite-latest', 1000, 1000)).toBeNull();
    });

    it('returns null when the model is undefined', () => {
      process.env.AI_MODEL_RATES = JSON.stringify({ m: { in: 1, out: 1 } });
      expect(computeCostMicros(undefined, 1000, 1000)).toBeNull();
    });

    it('does NOT return 0 for an unpriced model — null and 0 must stay distinct', () => {
      delete process.env.AI_MODEL_RATES;
      expect(computeCostMicros('m', 5000, 5000)).not.toBe(0);
    });
  });

  describe('arithmetic', () => {
    it('prices input and output at their separate rates', () => {
      // 1M in @ 2.0 + 1M out @ 4.0 = 6.0 units = 6_000_000 micros
      process.env.AI_MODEL_RATES = JSON.stringify({ m: { in: 2, out: 4 } });
      expect(computeCostMicros('m', 1_000_000, 1_000_000)).toBe(6_000_000);
    });

    it('scales linearly below one million tokens', () => {
      process.env.AI_MODEL_RATES = JSON.stringify({ m: { in: 2, out: 4 } });
      // 100k in @2 = 0.2 ; 50k out @4 = 0.2 ; total 0.4 units = 400_000 micros
      expect(computeCostMicros('m', 100_000, 50_000)).toBe(400_000);
    });

    it('keeps sub-fils calls measurable — the reason the column is micros', () => {
      process.env.AI_MODEL_RATES = JSON.stringify({ m: { in: 0.1, out: 0.4 } });
      // A realistic single call: 800 in / 300 out. In integer fils this would
      // round to 0 and the column would be useless.
      const micros = computeCostMicros('m', 800, 300);
      expect(micros).toBeGreaterThan(0);
    });

    it('treats zero tokens as zero cost when a rate exists', () => {
      process.env.AI_MODEL_RATES = JSON.stringify({ m: { in: 2, out: 4 } });
      expect(computeCostMicros('m', 0, 0)).toBe(0);
    });

    it('ignores negative or non-finite token counts rather than producing negative spend', () => {
      process.env.AI_MODEL_RATES = JSON.stringify({ m: { in: 2, out: 4 } });
      expect(computeCostMicros('m', -100, -100)).toBe(0);
      expect(computeCostMicros('m', Number.NaN, 1_000_000)).toBe(4_000_000);
    });
  });

  describe('malformed configuration behaves as unpriced, never as free', () => {
    it('invalid JSON yields null rather than 0', () => {
      process.env.AI_MODEL_RATES = '{not json';
      expect(computeCostMicros('m', 1000, 1000)).toBeNull();
    });

    it('a rate entry missing a field is rejected', () => {
      process.env.AI_MODEL_RATES = JSON.stringify({ m: { in: 2 } });
      expect(computeCostMicros('m', 1000, 1000)).toBeNull();
    });

    it('a negative rate is rejected', () => {
      process.env.AI_MODEL_RATES = JSON.stringify({ m: { in: -2, out: 4 } });
      expect(computeCostMicros('m', 1000, 1000)).toBeNull();
    });

    it('a valid entry alongside a malformed one still works', () => {
      process.env.AI_MODEL_RATES = JSON.stringify({ good: { in: 2, out: 4 }, bad: { in: 'x' } });
      expect(computeCostMicros('good', 1_000_000, 0)).toBe(2_000_000);
      expect(computeCostMicros('bad', 1_000_000, 0)).toBeNull();
    });
  });

  describe('hasAnyRateConfigured', () => {
    it('is false with no env set — lets the UI explain an empty cost column', () => {
      delete process.env.AI_MODEL_RATES;
      expect(hasAnyRateConfigured()).toBe(false);
    });

    it('is true once a valid rate exists', () => {
      process.env.AI_MODEL_RATES = JSON.stringify({ m: { in: 1, out: 1 } });
      expect(hasAnyRateConfigured()).toBe(true);
    });
  });
});
