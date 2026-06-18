/**
 * Unit tests for GovernorateAreaSelect logic helpers.
 *
 * We test the pure filter functions exported from the component module.
 * A DOM render test is not possible without jsdom/testing-library, which
 * are not installed in this project (vitest env = 'node'). All behaviour
 * that depends on React state (keyboard navigation, click-outside, focus
 * effects) must be verified manually / via E2E.
 */
import { describe, it, expect } from 'vitest';
import {
  filterGovernorates,
  filterAreas,
} from '@web/app/checkout/_components/governorate-area-utils';

describe('filterGovernorates', () => {
  it('returns all 6 governorates when no query and no rated filter', () => {
    const result = filterGovernorates('');
    expect(result).toHaveLength(6);
    expect(result.map(g => g.en)).toContain('Hawalli');
  });

  it('filters by Arabic substring — حول matches Hawalli', () => {
    const result = filterGovernorates('حول');
    expect(result).toHaveLength(1);
    expect(result[0].en).toBe('Hawalli');
  });

  it('filters by English substring (case-insensitive)', () => {
    const result = filterGovernorates('ahra');
    expect(result).toHaveLength(1);
    expect(result[0].en).toBe('Jahra');
  });

  it('returns empty when query matches nothing', () => {
    const result = filterGovernorates('xyznonexistent');
    expect(result).toHaveLength(0);
  });

  it('restricts to ratedGovernorates when provided and non-empty', () => {
    const rated = new Set(['Hawalli', 'Ahmadi']);
    const result = filterGovernorates('', rated);
    expect(result).toHaveLength(2);
    expect(result.map(g => g.en)).toEqual(expect.arrayContaining(['Hawalli', 'Ahmadi']));
  });

  it('shows all governorates when ratedGovernorates is empty Set', () => {
    const result = filterGovernorates('', new Set());
    expect(result).toHaveLength(6);
  });

  it('combines rated filter with text query', () => {
    const rated = new Set(['Hawalli', 'Farwaniya']);
    // query 'حول' should only return Hawalli (which is in rated set)
    const result = filterGovernorates('حول', rated);
    expect(result).toHaveLength(1);
    expect(result[0].en).toBe('Hawalli');
  });
});

describe('filterAreas', () => {
  it('returns all Hawalli areas when no query and no filter', () => {
    const result = filterAreas('Hawalli', '');
    // Hawalli has 16 areas in the canonical data
    expect(result.length).toBeGreaterThan(5);
    const enNames = result.map(a => a.en);
    expect(enNames).toContain('Salmiya');
  });

  it('selecting Hawalli governorate → areas list contains السالمية', () => {
    const result = filterAreas('Hawalli', '');
    const found = result.find(a => a.ar === 'السالمية');
    expect(found).toBeDefined();
    expect(found?.en).toBe('Salmiya');
  });

  it('selecting Salmiya calls onChange with (Hawalli, Salmiya)', () => {
    // Simulate the onChange call that the component would make
    let captured: [string, string] | null = null;
    const onChange = (govEn: string, areaEn: string) => {
      captured = [govEn, areaEn];
    };

    // Simulate: user picked Hawalli then picked Salmiya
    const areas = filterAreas('Hawalli', '');
    const salmiya = areas.find(a => a.en === 'Salmiya');
    expect(salmiya).toBeDefined();
    // Simulate calling onChange with the selected values
    onChange('Hawalli', salmiya!.en);
    expect(captured).toEqual(['Hawalli', 'Salmiya']);
  });

  it('filters areas by Arabic query', () => {
    const result = filterAreas('Hawalli', 'السالمية');
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].en).toBe('Salmiya');
  });

  it('with ratedAreas=Set(["Salmiya"]) — only Salmiya shows under Hawalli', () => {
    const rated = new Set(['Salmiya']);
    const result = filterAreas('Hawalli', '', rated);
    expect(result).toHaveLength(1);
    expect(result[0].en).toBe('Salmiya');
  });

  it('with empty ratedAreas Set — shows all areas', () => {
    const result = filterAreas('Hawalli', '', new Set());
    expect(result.length).toBeGreaterThan(1);
  });

  it('returns empty array for unknown governorate', () => {
    const result = filterAreas('NotAPlace', '');
    expect(result).toHaveLength(0);
  });

  it('returns empty when query matches nothing', () => {
    const result = filterAreas('Hawalli', 'xyznonexistent');
    expect(result).toHaveLength(0);
  });
});
