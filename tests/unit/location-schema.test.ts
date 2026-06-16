import { describe, it, expect } from 'vitest';
import { locationInputSchema, mapsSearchUrl } from '../../packages/shared/src/schemas/location';

describe('locationInputSchema', () => {
  it('accepts a minimal valid location', () => {
    const r = locationInputSchema.safeParse({
      name: 'Avenues',
      country: 'Kuwait',
      address: 'Al-Rai',
    });
    expect(r.success).toBe(true);
  });
  it('requires name, country, address', () => {
    expect(
      locationInputSchema.safeParse({ name: '', country: 'Kuwait', address: 'x' }).success
    ).toBe(false);
    expect(locationInputSchema.safeParse({ name: 'A', country: '', address: 'x' }).success).toBe(
      false
    );
  });
  it('rejects a non-http maps url (anti-XSS)', () => {
    expect(
      locationInputSchema.safeParse({
        name: 'A',
        country: 'K',
        address: 'x',
        mapsUrl: 'javascript:alert(1)',
      }).success
    ).toBe(false);
  });
  it('accepts https maps urls', () => {
    expect(
      locationInputSchema.safeParse({
        name: 'A',
        country: 'K',
        address: 'x',
        mapsUrl: 'https://www.google.com/maps/search/?api=1&query=X',
      }).success
    ).toBe(true);
  });
});

describe('mapsSearchUrl', () => {
  it('builds a google maps search url from a query', () => {
    expect(mapsSearchUrl('Avenues Mall Kuwait')).toBe(
      'https://www.google.com/maps/search/?api=1&query=Avenues%20Mall%20Kuwait'
    );
  });
});
