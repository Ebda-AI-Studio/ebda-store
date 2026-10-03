import { describe, it, expect } from 'vitest';
import {
  locationInputSchema,
  mapsSearchUrl,
  mapsEmbedSrc,
} from '../../packages/shared/src/schemas/location';

describe('locationInputSchema', () => {
  it('accepts a minimal valid location', () => {
    const r = locationInputSchema.safeParse({
      name: 'Avenues',
      country: 'Egypt',
      address: 'Al-Rai',
    });
    expect(r.success).toBe(true);
  });
  it('requires name, country, address', () => {
    expect(
      locationInputSchema.safeParse({ name: '', country: 'Egypt', address: 'x' }).success
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
    expect(mapsSearchUrl('Avenues Mall Egypt')).toBe(
      'https://www.google.com/maps/search/?api=1&query=Avenues%20Mall%20Egypt'
    );
  });
});

describe('mapsEmbedSrc', () => {
  it('builds a key-free output=embed src from a free-text query', () => {
    expect(mapsEmbedSrc({ fallbackQuery: 'Avenues Mall Egypt' })).toBe(
      'https://www.google.com/maps?q=Avenues%20Mall%20Egypt&output=embed'
    );
  });

  it('uses an explicit /maps/embed URL verbatim', () => {
    const embed = 'https://www.google.com/maps/embed?pb=!1m18!1m12';
    expect(mapsEmbedSrc({ mapsEmbedUrl: embed })).toBe(embed);
  });

  it('uses a URL already carrying output=embed verbatim', () => {
    const embed = 'https://maps.google.com/maps?q=Egypt&output=embed';
    expect(mapsEmbedSrc({ mapsEmbedUrl: embed })).toBe(embed);
  });

  it('parses @lat,lng out of a /maps/place share link', () => {
    const share = 'https://www.google.com/maps/place/Avenues/@29.3022,47.9389,17z/data=!3m1';
    expect(mapsEmbedSrc({ mapsUrl: share })).toBe(
      'https://www.google.com/maps?q=29.3022%2C47.9389&output=embed'
    );
  });

  it('parses a q= query param out of a share link', () => {
    const share = 'https://maps.google.com/?q=The+Avenues+Egypt';
    // URLSearchParams decodes `+` → space; we re-encode to %20.
    expect(mapsEmbedSrc({ mapsUrl: share })).toBe(
      'https://www.google.com/maps?q=The%20Avenues%20Egypt&output=embed'
    );
  });

  it('decodes a /maps/place/<name> link with no coords', () => {
    const share = 'https://www.google.com/maps/place/Avenues+Mall';
    expect(mapsEmbedSrc({ mapsUrl: share })).toBe(
      'https://www.google.com/maps?q=Avenues%20Mall&output=embed'
    );
  });

  it('falls back to the address when the share link has nothing usable', () => {
    const share = 'https://maps.app.goo.gl/abc123';
    expect(mapsEmbedSrc({ mapsUrl: share, fallbackQuery: 'Salmiya, Egypt' })).toBe(
      'https://www.google.com/maps?q=Salmiya%2C%20Egypt&output=embed'
    );
  });

  it('returns undefined when nothing usable is available', () => {
    expect(mapsEmbedSrc({})).toBeUndefined();
    expect(mapsEmbedSrc({ mapsUrl: 'http://insecure.example/maps' })).toBeUndefined();
  });

  it('ignores a non-embed http(s) mapsEmbedUrl and uses fallback instead', () => {
    // A plain share link mistakenly put in the embed field is NOT used verbatim.
    expect(
      mapsEmbedSrc({
        mapsEmbedUrl: 'https://maps.google.com/?q=place',
        fallbackQuery: 'Cairo',
      })
    ).toBe('https://www.google.com/maps?q=Cairo&output=embed');
  });
});
