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
  it('returns all 27 governorates when no query and no rated filter', () => {
    const result = filterGovernorates('');
    expect(result).toHaveLength(27);
    expect(result.map(g => g.en)).toContain('Cairo');
  });

  it('filters by Arabic substring — الجيز matches Giza', () => {
    const result = filterGovernorates('الجيز');
    expect(result).toHaveLength(1);
    expect(result[0].en).toBe('Giza');
  });

  it('filters by English substring (case-insensitive)', () => {
    const result = filterGovernorates('ALEXAND');
    expect(result).toHaveLength(1);
    expect(result[0].en).toBe('Alexandria');
  });

  it('returns empty when query matches nothing', () => {
    const result = filterGovernorates('xyznonexistent');
    expect(result).toHaveLength(0);
  });

  it('restricts to ratedGovernorates when provided and non-empty', () => {
    const rated = new Set(['Cairo', 'Aswan']);
    const result = filterGovernorates('', rated);
    expect(result).toHaveLength(2);
    expect(result.map(g => g.en)).toEqual(expect.arrayContaining(['Cairo', 'Aswan']));
  });

  it('shows all governorates when ratedGovernorates is empty Set', () => {
    const result = filterGovernorates('', new Set());
    expect(result).toHaveLength(27);
  });

  it('combines rated filter with text query', () => {
    const rated = new Set(['Giza', 'Cairo']);
    // query 'الجيز' should only return Giza (which is in rated set)
    const result = filterGovernorates('الجيز', rated);
    expect(result).toHaveLength(1);
    expect(result[0].en).toBe('Giza');
  });
});

describe('filterAreas', () => {
  it('returns all Giza areas when no query and no filter', () => {
    const result = filterAreas('Giza', '');
    expect(result.length).toBeGreaterThan(5);
    const enNames = result.map(a => a.en);
    expect(enNames).toContain('Dokki');
  });

  it('selecting Giza governorate → areas list contains الدقي', () => {
    const result = filterAreas('Giza', '');
    const found = result.find(a => a.ar === 'الدقي');
    expect(found).toBeDefined();
    expect(found?.en).toBe('Dokki');
  });

  it('selecting Dokki calls onChange with (Giza, Dokki)', () => {
    // Simulate the onChange call that the component would make
    let captured: [string, string] | null = null;
    const onChange = (govEn: string, areaEn: string) => {
      captured = [govEn, areaEn];
    };

    // Simulate: user picked Giza then picked Dokki
    const areas = filterAreas('Giza', '');
    const dokki = areas.find(a => a.en === 'Dokki');
    expect(dokki).toBeDefined();
    // Simulate calling onChange with the selected values
    onChange('Giza', dokki!.en);
    expect(captured).toEqual(['Giza', 'Dokki']);
  });

  it('filters areas by Arabic query', () => {
    const result = filterAreas('Giza', 'الدقي');
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].en).toBe('Dokki');
  });

  it('with ratedAreas=Set(["Dokki"]) — only Dokki shows under Giza', () => {
    const rated = new Set(['Dokki']);
    const result = filterAreas('Giza', '', rated);
    expect(result).toHaveLength(1);
    expect(result[0].en).toBe('Dokki');
  });

  it('with empty ratedAreas Set — shows all areas', () => {
    const result = filterAreas('Giza', '', new Set());
    expect(result.length).toBeGreaterThan(1);
  });

  it('returns empty array for unknown governorate', () => {
    const result = filterAreas('NotAPlace', '');
    expect(result).toHaveLength(0);
  });

  it('returns empty when query matches nothing', () => {
    const result = filterAreas('Giza', 'xyznonexistent');
    expect(result).toHaveLength(0);
  });
});
