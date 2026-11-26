import { describe, expect, it } from 'vitest';
import { limitLevel, limitPct, worstLevel } from './plan-limits';

describe('limitLevel boundaries', () => {
  it('79% is ok', () => expect(limitLevel(79, 100)).toBe('ok'));
  it('80% is warn', () => expect(limitLevel(80, 100)).toBe('warn'));
  it('99% is warn', () => expect(limitLevel(99, 100)).toBe('warn'));
  it('100% is full', () => expect(limitLevel(100, 100)).toBe('full'));
  it('over the limit is full', () => expect(limitLevel(130, 100)).toBe('full'));
  it('uses the raw ratio, not the rounded one (79.6% is ok)', () => {
    expect(limitLevel(796, 1000)).toBe('ok');
    expect(limitPct(796, 1000)).toBe(80);
  });
  it('unlimited never warns', () => {
    expect(limitLevel(1_000_000, null)).toBe('ok');
    expect(limitLevel(5, undefined)).toBe('ok');
  });
  it('a plan that includes none is full', () => expect(limitLevel(0, 0)).toBe('full'));
  it('worstLevel picks the worse', () => {
    expect(worstLevel('warn', 'full')).toBe('full');
    expect(worstLevel('ok', 'warn')).toBe('warn');
  });
});
