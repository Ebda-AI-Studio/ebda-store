import { describe, expect, it } from 'vitest';
import { ratioOrNull } from '../ratio';

describe('ratioOrNull', () => {
  it('is unknown (null), not 0, over a zero or missing count', () => {
    expect(ratioOrNull(0, 0)).toBeNull();
    expect(ratioOrNull(5, 0)).toBeNull();
    expect(ratioOrNull(1, Number.NaN)).toBeNull();
  });
  it('is the ratio otherwise, including a real zero', () => {
    expect(ratioOrNull(1, 4)).toBe(0.25);
    expect(ratioOrNull(0, 10)).toBe(0);
  });
});
