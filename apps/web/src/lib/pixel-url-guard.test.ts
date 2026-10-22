import { describe, expect, it } from 'vitest';
import { urlCarriesPixelBlockedQuery } from './pixel-url-guard';

describe('urlCarriesPixelBlockedQuery', () => {
  it.each([
    '?q=01012345678',
    '?search=x',
    '?email=a%40b.com',
    '?phone=010',
    '?token=abc',
    '?restore=abc',
    '?waToken=abc',
    '?Q=x',
    '?sort=newest&q=x',
    '?q[]=x',
  ])('blocks %s', search => {
    expect(urlCarriesPixelBlockedQuery(search)).toBe(true);
    expect(urlCarriesPixelBlockedQuery(new URLSearchParams(search))).toBe(true);
  });

  it.each(['', '?', '?sort=newest', '?category=abc&page=2', '?ref=partner', '?utm_source=meta'])(
    'allows %s',
    search => {
      expect(urlCarriesPixelBlockedQuery(search)).toBe(false);
    }
  );

  it('allows null', () => {
    expect(urlCarriesPixelBlockedQuery(null)).toBe(false);
  });
});
