import { describe, it, expect } from 'vitest';
import { organizationJsonLd } from '../structured-data';
import type { ResolvedStore } from '../store-resolver';

/**
 * A2 (2026-09-22 AEO audit): Organization JSON-LD never emitted
 * `description` or `areaServed` under any input, and spread the GEO
 * brand-facts sweep's non-schema `aboutJson` keys (`region`, `currency`,
 * `location`, `languages`, `keyCategories`, `contactMethods`) directly onto
 * a schema.org node instead of wrapping them as `additionalProperty`
 * `PropertyValue` entries.
 */

const ARABIC_RANGE = /[؀-ۿ]/;

function makeStore(overrides: Partial<ResolvedStore> = {}): ResolvedStore {
  return {
    id: 'store-1',
    name: 'Demo Store',
    slug: 'demo-store',
    domain: 'demo-store.example',
    status: 'active',
    currency: 'EGP',
    timezone: 'Africa/Cairo',
    template: 'elegant',
    theme: {},
    socialLinks: {},
    ...overrides,
  } as unknown as ResolvedStore;
}

describe('organizationJsonLd', () => {
  it("emits a locale-correct description from the store's own fields", () => {
    const store = makeStore({
      description: 'English store description',
      descriptionAr: 'وصف المتجر بالعربية',
    });

    const ar = organizationJsonLd(store, 'ar');
    expect(ar.description).toMatch(ARABIC_RANGE);
    expect(ar.description).not.toContain('English store description');

    const en = organizationJsonLd(store, 'en');
    expect(en.description).toBe('English store description');
  });

  it('omits description entirely when the store has none in either locale (never invents one)', () => {
    const store = makeStore();
    const node = organizationJsonLd(store, 'en');
    expect(node).not.toHaveProperty('description');
  });

  it('emits areaServed as Text from aboutJson.location, never invented when absent', () => {
    const withLocation = organizationJsonLd(makeStore({ aboutJson: { location: 'Egypt' } }), 'en');
    expect(withLocation.areaServed).toBe('Egypt');

    const withoutAboutJson = organizationJsonLd(makeStore(), 'en');
    expect(withoutAboutJson).not.toHaveProperty('areaServed');
  });

  it('falls back to aboutJson.region for areaServed when location is absent', () => {
    const node = organizationJsonLd(makeStore({ aboutJson: { region: 'GCC' } }), 'en');
    expect(node.areaServed).toBe('GCC');
  });

  it('folds every other aboutJson key into additionalProperty PropertyValue entries, none dropped', () => {
    const store = makeStore({
      aboutJson: {
        location: 'Egypt',
        region: 'GCC',
        currency: 'EGP',
        languages: ['Arabic', 'English'],
        keyCategories: ['Nuts', 'Dried Fruit'],
        contactMethods: ['email', 'whatsapp'],
      },
    });

    const node = organizationJsonLd(store, 'en');
    // location/region are consumed by areaServed, not duplicated here.
    expect(node.additionalProperty).toEqual(
      expect.arrayContaining([
        { '@type': 'PropertyValue', name: 'currency', value: 'EGP' },
        { '@type': 'PropertyValue', name: 'languages', value: 'Arabic, English' },
        { '@type': 'PropertyValue', name: 'keyCategories', value: 'Nuts, Dried Fruit' },
        { '@type': 'PropertyValue', name: 'contactMethods', value: 'email, whatsapp' },
      ])
    );
    expect(node.additionalProperty).toHaveLength(4);
    // No raw top-level keys from aboutJson leaking onto the node directly.
    expect(node).not.toHaveProperty('currency');
    expect(node).not.toHaveProperty('languages');
  });

  it('never publishes "[object Object]" or "null" for a non-primitive aboutJson value (#1892)', () => {
    const node = organizationJsonLd(
      makeStore({
        aboutJson: {
          currency: 'EGP',
          contactMethods: [{ type: 'email', value: 'x@y.com' }],
          address: { city: 'Cairo' },
          fax: null,
          languages: ['Arabic', 'English'],
        },
      }),
      'en'
    );
    const json = JSON.stringify(node);
    expect(json).not.toContain('[object Object]');
    expect(json).not.toContain('"null"');
    expect(node.additionalProperty).toEqual([
      { '@type': 'PropertyValue', name: 'currency', value: 'EGP' },
      { '@type': 'PropertyValue', name: 'languages', value: 'Arabic, English' },
    ]);
  });

  it('omits additionalProperty entirely when there is no aboutJson', () => {
    const node = organizationJsonLd(makeStore(), 'en');
    expect(node).not.toHaveProperty('additionalProperty');
  });

  it('is valid-shaped schema.org JSON-LD: @context + @type always present, name/url always set', () => {
    const node = organizationJsonLd(makeStore(), 'en');
    expect(node['@context']).toBe('https://schema.org');
    expect(node['@type']).toBe('Organization');
    expect(node.name).toBe('Demo Store');
    expect(typeof node.url).toBe('string');
  });
});
