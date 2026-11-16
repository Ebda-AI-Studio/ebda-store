import { describe, it, expect } from 'vitest';
import { toDelta, sparkBars } from './pulse-format';

describe('toDelta', () => {
  it('classifies up, down and flat', () => {
    expect(toDelta(12.4)).toEqual({ tone: 'up', percent: 12 });
    expect(toDelta(-30)).toEqual({ tone: 'down', percent: 30 });
    expect(toDelta(0.2)).toEqual({ tone: 'flat', percent: 0 });
  });
  it('is unknown (null) for missing or non-finite input, never 0%', () => {
    expect(toDelta(null)).toBeNull();
    expect(toDelta(undefined)).toBeNull();
    expect(toDelta(Number.NaN)).toBeNull();
  });
});

describe('sparkBars', () => {
  it('normalises to the max', () => {
    expect(sparkBars([0, 5, 10])).toEqual([0, 0.5, 1]);
  });
  it('flat zero series stays zero (no NaN)', () => {
    expect(sparkBars([0, 0])).toEqual([0, 0]);
    expect(sparkBars([])).toEqual([]);
  });
});
