/**
 * Shipping area-rate import — unit tests for the row-resolution logic.
 * Covers area-name → canonical governorate resolution + KWD→fils parsing.
 */

import { describe, it, expect } from 'vitest';

import { resolveImportRow, parseKwdToFils } from '../../apps/api/src/routes/shipping.routes';

describe('parseKwdToFils', () => {
  it('converts a KWD number to integer fils', () => {
    expect(parseKwdToFils(1.5)).toBe(1500);
  });

  it('converts a KWD string to integer fils', () => {
    expect(parseKwdToFils('2.250')).toBe(2250);
  });

  it('rounds to the nearest fils', () => {
    expect(parseKwdToFils('1.2345')).toBe(1235);
  });

  it('returns null for blank / undefined / invalid / negative', () => {
    expect(parseKwdToFils('')).toBeNull();
    expect(parseKwdToFils(undefined)).toBeNull();
    expect(parseKwdToFils('abc')).toBeNull();
    expect(parseKwdToFils(-1)).toBeNull();
  });

  it('treats 0 as a valid zero fee', () => {
    expect(parseKwdToFils(0)).toBe(0);
    expect(parseKwdToFils('0')).toBe(0);
  });
});

describe('resolveImportRow', () => {
  it('resolves an EN area name (case-insensitive) to its canonical governorate + AR names', () => {
    const r = resolveImportRow({ area: 'salmiya', deliveryFee: '1.500' }, 1);
    expect('value' in r).toBe(true);
    if ('value' in r) {
      expect(r.value.governorate).toBe('Hawalli');
      expect(r.value.area).toBe('Salmiya');
      expect(r.value.areaAr).toBe('السالمية');
      expect(r.value.governorateAr).toBe('حولي');
      expect(r.value.deliveryFee).toBe(1500);
      expect(r.value.isActive).toBe(true);
    }
  });

  it('resolves by the exact Arabic area name', () => {
    const r = resolveImportRow({ area: 'السالمية', deliveryFee: 2 }, 1);
    expect('value' in r).toBe(true);
    if ('value' in r) {
      expect(r.value.area).toBe('Salmiya');
      expect(r.value.deliveryFee).toBe(2000);
    }
  });

  it('flags an unknown area', () => {
    const r = resolveImportRow({ area: 'Atlantis', deliveryFee: '1' }, 7);
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error.reason).toBe('unknown area');
      expect(r.error.row).toBe(7);
    }
  });

  it('flags a governorate mismatch when an explicit governorate is wrong', () => {
    const r = resolveImportRow({ governorate: 'Capital', area: 'Salmiya', deliveryFee: '1' }, 3);
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error.reason).toContain('governorate mismatch');
    }
  });

  it('accepts a matching explicit governorate (EN or AR)', () => {
    const en = resolveImportRow({ governorate: 'Hawalli', area: 'Salmiya', deliveryFee: '1' }, 1);
    expect('value' in en).toBe(true);
    const ar = resolveImportRow({ governorate: 'حولي', area: 'Salmiya', deliveryFee: '1' }, 1);
    expect('value' in ar).toBe(true);
  });

  it('flags an invalid delivery fee', () => {
    const r = resolveImportRow({ area: 'Salmiya', deliveryFee: 'free' }, 2);
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error.reason).toBe('invalid delivery fee');
  });

  it('parses an optional free-shipping threshold to fils', () => {
    const r = resolveImportRow(
      { area: 'Salmiya', deliveryFee: '1.500', freeShippingThreshold: '10' },
      1
    );
    expect('value' in r).toBe(true);
    if ('value' in r) expect(r.value.freeShippingThreshold).toBe(10000);
  });

  it('leaves the threshold null when blank', () => {
    const r = resolveImportRow(
      { area: 'Salmiya', deliveryFee: '1.500', freeShippingThreshold: '' },
      1
    );
    expect('value' in r).toBe(true);
    if ('value' in r) expect(r.value.freeShippingThreshold).toBeNull();
  });

  it('parses a loose Active cell (Yes/No)', () => {
    const yes = resolveImportRow({ area: 'Salmiya', deliveryFee: '1', isActive: 'Yes' }, 1);
    const no = resolveImportRow({ area: 'Salmiya', deliveryFee: '1', isActive: 'No' }, 1);
    if ('value' in yes) expect(yes.value.isActive).toBe(true);
    if ('value' in no) expect(no.value.isActive).toBe(false);
  });
});
