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

describe('toDelta with a previous period of zero (D1)', () => {
  it('is "new", never a percentage, when there is something now and nothing before', () => {
    expect(toDelta(100, { previous: 0, current: 5000 })).toEqual({ tone: 'new', percent: 0 });
  });
  it('is no delta at all when both periods are zero', () => {
    expect(toDelta(0, { previous: 0, current: 0 })).toBeNull();
  });
  it('still shows a real +100% when the previous period had sales', () => {
    expect(toDelta(100, { previous: 2500, current: 5000 })).toEqual({ tone: 'up', percent: 100 });
  });
  it('falls back to the percentage when the API did not send the previous total', () => {
    expect(toDelta(100, { current: 5000 })).toEqual({ tone: 'up', percent: 100 });
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
