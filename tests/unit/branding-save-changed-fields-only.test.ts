/**
 * Branding save sends only the identity fields the merchant changed. Sending all of them wrote the Arabic name back from the
 * copy loaded at mount whenever the English name (or the theme) was the only thing edited.
 * Mutation-proof: restoring the whole-object `branding: { name, nameAr, ... }` reddens the source guard and, through
 * `brandingPatch` returning every key, the unit cases.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { brandingPatch } from '@admin/app/stores/[id]/branding/_hooks/branding-patch';

describe('brandingPatch', () => {
  const loaded = { name: 'Shop', nameAr: 'متجر', description: 'd', descriptionAr: 'و' };

  it('editing only the English name never carries the Arabic name', () => {
    expect(brandingPatch(loaded, { ...loaded, name: 'Shop 2' })).toEqual({ name: 'Shop 2' });
  });

  it('editing only the Arabic name never carries the English name', () => {
    expect(brandingPatch(loaded, { ...loaded, nameAr: 'متجري' })).toEqual({ nameAr: 'متجري' });
  });

  it('a cleared field is sent as an empty string, an untouched null/undefined is not sent', () => {
    expect(brandingPatch(loaded, { ...loaded, nameAr: '' })).toEqual({ nameAr: '' });
    expect(brandingPatch({ name: 'a', nameAr: null }, { name: 'a', nameAr: undefined })).toEqual(
      {}
    );
    expect(brandingPatch({ name: 'a', nameAr: null }, { name: 'a', nameAr: '' })).toEqual({});
  });

  it('no change sends nothing', () => {
    expect(brandingPatch(loaded, { ...loaded })).toEqual({});
  });
});

describe('useBranding save', () => {
  it('builds the branding part with brandingPatch, not the whole object', () => {
    const src = readFileSync(
      resolve(__dirname, '../../apps/admin/src/app/stores/[id]/branding/_hooks/useBranding.ts'),
      'utf8'
    );
    expect(src).toMatch(/branding:\s*brandingPatch\(/);
    expect(src).not.toMatch(/nameAr:\s*branding\.nameAr/);
  });
});
