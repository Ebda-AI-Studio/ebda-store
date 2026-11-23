import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from './catalog';
import { PROVIDER_LOGOS, SOCIAL_LOGO_CODES, getProviderLogo } from './logos';

describe('provider logo registry', () => {
  it.each(PROVIDER_CATALOG.map(p => p.code))('has an entry (asset or wordmark) for %s', code => {
    expect(Object.prototype.hasOwnProperty.call(PROVIDER_LOGOS, code)).toBe(true);
    const e = PROVIDER_LOGOS[code];
    expect(e.asset === null ? e.missing !== null : e.missing === null).toBe(true);
  });

  it('has no entry for a provider that left the catalog', () => {
    const codes = new Set<string>([...PROVIDER_CATALOG.map(p => p.code), ...SOCIAL_LOGO_CODES]);
    for (const code of Object.keys(PROVIDER_LOGOS)) expect(codes.has(code)).toBe(true);
  });

  it.each([...SOCIAL_LOGO_CODES])('has an entry for social platform %s', code => {
    expect(PROVIDER_LOGOS[code]).toBeDefined();
  });

  it('unknown code falls back to a wordmark', () => {
    expect(getProviderLogo('nope').asset).toBeNull();
  });

  const withAsset = Object.entries(PROVIDER_LOGOS).filter(([, e]) => e.asset);
  it.each(withAsset)('%s asset exists, is small, and an SVG is inert', (_code, e) => {
    const file = resolve(__dirname, '../../../../apps/admin/public', `.${e.asset}`);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBeLessThan(60_000);
    if (file.endsWith('.svg')) {
      const svg = readFileSync(file, 'utf8');
      expect(svg).toMatch(/<svg[\s>]/);
      expect(svg).not.toMatch(/<script|\son[a-z]+=|href="https?:|data:/i);
    }
  });
});
