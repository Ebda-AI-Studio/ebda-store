/**
 * Shipping area-rate import — unit tests for the row-resolution logic.
 * Covers area-name → canonical governorate resolution + EGP→piastres parsing.
 */

import { describe, it, expect } from 'vitest';

import { resolveImportRow, parseMajorToMinor } from '../../apps/api/src/routes/shipping.routes';

describe('parseMajorToMinor', () => {
  it('converts a EGP number to integer piastres', () => {
    expect(parseMajorToMinor(15)).toBe(1500);
    expect(parseMajorToMinor(1.5)).toBe(150);
  });

  it('converts a EGP string to integer piastres', () => {
    expect(parseMajorToMinor('22.50')).toBe(2250);
    expect(parseMajorToMinor('199.99')).toBe(19_999);
  });

  it('REJECTS more decimals than a piastre (never rounds a fee silently)', () => {
    expect(parseMajorToMinor('1.2345')).toBeNull();
    expect(parseMajorToMinor('1.999')).toBeNull();
    // A 3-decimal value is AMBIGUOUS in Egypt ("2.500" reads as two thousand
    // five hundred) — refused like the product import (ruling MONEYB-8).
    expect(parseMajorToMinor('2.500')).toBeNull();
    expect(parseMajorToMinor('2.50')).toBe(250);
    expect(parseMajorToMinor('٢٥٫٥٠')).toBe(2550);
  });

  it('returns null for blank / undefined / invalid / negative', () => {
    expect(parseMajorToMinor('')).toBeNull();
    expect(parseMajorToMinor(undefined)).toBeNull();
    expect(parseMajorToMinor('abc')).toBeNull();
    expect(parseMajorToMinor(-1)).toBeNull();
  });

  it('treats 0 as a valid zero fee', () => {
    expect(parseMajorToMinor(0)).toBe(0);
    expect(parseMajorToMinor('0')).toBe(0);
  });
});

describe('resolveImportRow', () => {
  it('resolves an EN area name (case-insensitive) to its canonical governorate + AR names', () => {
    const r = resolveImportRow({ area: 'maadi', deliveryFee: '15.00' }, 1);
    expect('value' in r).toBe(true);
    if ('value' in r) {
      expect(r.value.governorate).toBe('Cairo');
      expect(r.value.area).toBe('Maadi');
      expect(r.value.areaAr).toBe('المعادي');
      expect(r.value.governorateAr).toBe('القاهرة');
      expect(r.value.deliveryFee).toBe(1500);
      expect(r.value.isActive).toBe(true);
    }
  });

  it('resolves by the exact Arabic area name', () => {
    const r = resolveImportRow({ area: 'المعادي', deliveryFee: 20 }, 1);
    expect('value' in r).toBe(true);
    if ('value' in r) {
      expect(r.value.area).toBe('Maadi');
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
    const r = resolveImportRow({ governorate: 'Giza', area: 'Maadi', deliveryFee: '1' }, 3);
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error.reason).toContain('governorate mismatch');
    }
  });

  it('accepts a matching explicit governorate (EN or AR)', () => {
    const en = resolveImportRow({ governorate: 'Cairo', area: 'Maadi', deliveryFee: '1' }, 1);
    expect('value' in en).toBe(true);
    const ar = resolveImportRow({ governorate: 'القاهرة', area: 'Maadi', deliveryFee: '1' }, 1);
    expect('value' in ar).toBe(true);
  });

  it('flags an invalid delivery fee (non-numeric, or more than 2 decimals)', () => {
    const r = resolveImportRow({ area: 'Maadi', deliveryFee: 'free' }, 2);
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error.reason).toBe('invalid delivery fee');
    const r3 = resolveImportRow({ area: 'Maadi', deliveryFee: '1.999' }, 2);
    expect('error' in r3).toBe(true);
    if ('error' in r3) expect(r3.error.reason).toBe('invalid delivery fee');
  });

  it('parses an optional free-shipping threshold to piastres', () => {
    const r = resolveImportRow(
      { area: 'Maadi', deliveryFee: '15.00', freeShippingThreshold: '1000' },
      1
    );
    expect('value' in r).toBe(true);
    if ('value' in r) expect(r.value.freeShippingThreshold).toBe(100_000);
  });

  it('leaves the threshold null when blank', () => {
    const r = resolveImportRow(
      { area: 'Maadi', deliveryFee: '15.00', freeShippingThreshold: '' },
      1
    );
    expect('value' in r).toBe(true);
    if ('value' in r) expect(r.value.freeShippingThreshold).toBeNull();
  });

  it('parses a loose Active cell (Yes/No)', () => {
    const yes = resolveImportRow({ area: 'Maadi', deliveryFee: '1', isActive: 'Yes' }, 1);
    const no = resolveImportRow({ area: 'Maadi', deliveryFee: '1', isActive: 'No' }, 1);
    if ('value' in yes) expect(yes.value.isActive).toBe(true);
    if ('value' in no) expect(no.value.isActive).toBe(false);
  });
});
