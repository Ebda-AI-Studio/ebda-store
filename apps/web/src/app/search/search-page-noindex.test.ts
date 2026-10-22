/**
 * Search results are never indexed (Ruling SEARCH-URL-1). Before the term left the URL there was
 * one address per query; now there is one `/search` address, and either way its content is
 * whatever a visitor typed.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/seo/localized-metadata', () => ({
  localizedMetadata: async (m: Record<string, unknown>) => m,
}));
vi.mock('./SearchClient', () => ({ default: () => null }));

import { generateMetadata } from './page';

describe('/search metadata', () => {
  it('is noindex, nofollow', async () => {
    const meta = await generateMetadata();
    expect(meta.robots).toEqual({ index: false, follow: false });
  });
});
