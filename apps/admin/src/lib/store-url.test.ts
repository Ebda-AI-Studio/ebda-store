import { describe, expect, it } from 'vitest';
import { getBuilderPreviewOrigin, getStoreHref } from './store-url';

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
