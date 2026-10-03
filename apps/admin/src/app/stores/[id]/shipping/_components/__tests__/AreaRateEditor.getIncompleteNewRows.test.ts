import { describe, it, expect } from 'vitest';
import { getIncompleteNewRows, type IncompleteRowCheckInput } from '../areaRateValidation';

function makeRow(overrides: Partial<IncompleteRowCheckInput>): IncompleteRowCheckInput {
  return {
    area: 'Test Area',
    isActive: false,
    feeMajor: '',
    ...overrides,
  };
}

describe('getIncompleteNewRows', () => {
  it('flags a brand-new row added without a fee (the reported bug)', () => {
    const rows = [makeRow({ area: 'Salmiya', isActive: false, feeMajor: '' })];
    const result = getIncompleteNewRows(rows);
    expect(result).toHaveLength(1);
    expect(result[0].area).toBe('Salmiya');
  });

  it('does not flag a new row that has a fee (auto-flips isActive true)', () => {
    const rows = [makeRow({ area: 'Salmiya', isActive: true, feeMajor: '1.500' })];
    expect(getIncompleteNewRows(rows)).toHaveLength(0);
  });

  it('does not flag a new row explicitly activated with a 0 fee (free shipping)', () => {
    const rows = [makeRow({ area: 'Salmiya', isActive: true, feeMajor: '' })];
    expect(getIncompleteNewRows(rows)).toHaveLength(0);
  });

  it('does not flag an already-persisted row (has an id) even if inactive with no fee', () => {
    const rows = [makeRow({ id: 'db-id-1', area: 'Salmiya', isActive: false, feeMajor: '' })];
    expect(getIncompleteNewRows(rows)).toHaveLength(0);
  });

  it('does not flag an inactive new row that still has a non-zero fee (paused, not incomplete)', () => {
    const rows = [makeRow({ area: 'Salmiya', isActive: false, feeMajor: '2.000' })];
    expect(getIncompleteNewRows(rows)).toHaveLength(0);
  });

  it('collects multiple incomplete rows', () => {
    const rows = [
      makeRow({ area: 'Salmiya', isActive: false, feeMajor: '' }),
      makeRow({ id: 'db-id-2', area: 'Hawally', isActive: false, feeMajor: '' }),
      makeRow({ area: 'Farwaniya', isActive: false, feeMajor: '' }),
    ];
    const result = getIncompleteNewRows(rows);
    expect(result.map(r => r.area)).toEqual(['Salmiya', 'Farwaniya']);
  });
});
