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

// ---- the same rule for contact / social / settings.contact (stale-save class) -----------------------------------------
import { mergeNestedPatch } from '@api/lib/merge-nested-patch';
import {
  CONTACT_KEYS,
  keyPatch,
  settingsContactPatch,
} from '@admin/app/stores/[id]/branding/_hooks/branding-patch';

describe('a Branding save does not revert what another page set meanwhile', () => {
  it('SEO sets wikidata/wikipedia while Branding is open; Branding edits only facebook: the wiki keys are not sent', () => {
    const loadedSocial = { facebook: 'https://f.test/a', wikidata: 'https://w.test/old' };
    // Branding's copy still holds the OLD wikidata; the store now holds the SEO page's value
    const patch = keyPatch(loadedSocial, { ...loadedSocial, facebook: 'https://f.test/b' });
    expect(patch).toEqual({ facebook: 'https://f.test/b' });
    expect(patch).not.toHaveProperty('wikidata');
    expect(patch).not.toHaveProperty('wikipedia');
  });

  it('a cleared social key is sent as an empty string (the API removes it); an untouched page sends nothing', () => {
    expect(keyPatch({ facebook: 'x' }, {})).toEqual({ facebook: '' });
    expect(keyPatch({ facebook: 'x' }, { facebook: 'x' })).toEqual({});
  });

  it('contact: only the changed columns travel', () => {
    const loaded = { email: 'a@a.test', phone: '1', address: 'a' };
    expect(keyPatch(loaded, { ...loaded, phone: '2' }, CONTACT_KEYS)).toEqual({ phone: '2' });
  });

  it('settings.contact: only addressUrl / addressLink, and only when changed; a cleared URL is null', () => {
    expect(
      settingsContactPatch(
        { addressUrl: 'u', addressLink: true },
        { addressUrl: 'u', addressLink: true }
      )
    ).toEqual({});
    expect(
      settingsContactPatch({ addressUrl: 'u' }, { addressUrl: ' ', addressLink: false })
    ).toEqual({
      addressUrl: null,
      addressLink: false,
    });
  });

  it('server: the settings.contact patch merges per key into the live object, null deletes, other keys survive', () => {
    const live = { addressUrl: 'u', addressLink: true, hoursNote: 'set elsewhere' };
    expect(mergeNestedPatch(live, { addressLink: false })).toEqual({
      addressUrl: 'u',
      addressLink: false,
      hoursNote: 'set elsewhere',
    });
    expect(mergeNestedPatch(live, { addressUrl: null })).toEqual({
      addressLink: true,
      hoursNote: 'set elsewhere',
    });
  });

  it('useBranding sends patches, never the whole socialLinks / contact objects', () => {
    const src = readFileSync(
      resolve(__dirname, '../../apps/admin/src/app/stores/[id]/branding/_hooks/useBranding.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/social:\s*branding\.socialLinks/);
    expect(src).not.toMatch(/email:\s*branding\.email/);
    expect(src).not.toMatch(/contact:\s*nextContact/);
  });
});
