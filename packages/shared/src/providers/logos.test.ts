import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from './catalog';
import { PROVIDER_LOGOS, getProviderLogo } from './logos';

describe('provider logo registry', () => {
  it.each(PROVIDER_CATALOG.map(p => p.code))('has an entry (asset or wordmark) for %s', code => {
    expect(Object.prototype.hasOwnProperty.call(PROVIDER_LOGOS, code)).toBe(true);
    const e = PROVIDER_LOGOS[code];
    expect(e.asset === null ? e.missing !== null : e.missing === null).toBe(true);
  });

  it('has no entry for a provider that left the catalog', () => {
    const codes = new Set(PROVIDER_CATALOG.map(p => p.code));
    for (const code of Object.keys(PROVIDER_LOGOS)) expect(codes.has(code)).toBe(true);
  });

  it('unknown code falls back to a wordmark', () => {
    expect(getProviderLogo('nope').asset).toBeNull();
  });
});
