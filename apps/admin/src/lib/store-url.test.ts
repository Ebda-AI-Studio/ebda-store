import { describe, expect, it } from 'vitest';
import { getBuilderPreviewOrigin, getStoreHref, getStorePublicHost } from './store-url';

describe('getBuilderPreviewOrigin', () => {
  it('is the slug origin even when the store has a custom domain', () => {
    const store = { slug: 'pecanbee', domain: 'pecanbee.example' };
    expect(getStoreHref(store)).toBe('https://pecanbee.example');
    expect(getBuilderPreviewOrigin(store)).toBe('https://pecanbee.ebda.app');
  });
  it('is the slug origin for a store without a custom domain', () => {
    expect(getBuilderPreviewOrigin({ slug: 'amelia' })).toBe('https://amelia.ebda.app');
  });
});

describe('getStorePublicHost', () => {
  it('is the custom domain when verified or when the payload does not say', () => {
    expect(getStorePublicHost({ slug: 'amelia', domain: 'AmeliaAurum.com' })).toBe(
      'ameliaaurum.com'
    );
    expect(
      getStorePublicHost({
        slug: 'amelia',
        domain: 'ameliaaurum.com',
        domainVerifiedAt: '2026-11-01T00:00:00Z',
      })
    ).toBe('ameliaaurum.com');
  });
  it('is <slug>.ebda.app without a domain or while the domain is unverified', () => {
    expect(getStorePublicHost({ slug: 'amelia' })).toBe('amelia.ebda.app');
    expect(
      getStorePublicHost({ slug: 'amelia', domain: 'ameliaaurum.com', domainVerifiedAt: null })
    ).toBe('amelia.ebda.app');
  });
});
