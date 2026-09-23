import { describe, it, expect } from 'vitest';
import { fixCategoryLinks, buildPerStoreBody } from './route';

/**
 * A4-2 (2026-09-22 AEO audit): `/categories/<slug>` is not a real route
 * anywhere in this Next.js app (category browsing lives at
 * `/products?category=<slug>` — see `ProductsPageBody.tsx`). Verified live
 * 2026-09-22: every `/categories/*` link in both pecannbee.com.kw's and
 * wadyaljuz.com's served llms.txt 404'd (18/18, not just the two the audit
 * sampled).
 *
 * "Add a test that every link the generator emits resolves to an existing
 * route/slug" — these assert that invariant directly: for every category
 * link line that survives `fixCategoryLinks`, the emitted slug is a member
 * of the live category set passed in.
 */

const LIVE_CATEGORIES = [{ slug: 'nuts' }, { slug: 'dried-fruit' }];

describe('fixCategoryLinks', () => {
  it('rewrites a live category slug to the real /products?category= URL', () => {
    const body = '- Nuts / مكسرات: https://pecannbee.com.kw/categories/nuts';
    const out = fixCategoryLinks(body, LIVE_CATEGORIES);
    expect(out).toBe('- Nuts / مكسرات: https://pecannbee.com.kw/products?category=nuts');
  });

  it('drops the whole line for a slug that matches no live category (hallucinated or deleted)', () => {
    const body = [
      '- Nuts / مكسرات: https://pecannbee.com.kw/categories/nuts',
      '- Honey and olive oil: https://pecannbee.com.kw/categories/honey-and-olive-oil',
      '- Dragee: https://pecannbee.com.kw/categories/dragee',
    ].join('\n');

    const out = fixCategoryLinks(body, LIVE_CATEGORIES);

    expect(out).toBe('- Nuts / مكسرات: https://pecannbee.com.kw/products?category=nuts');
    expect(out).not.toContain('honey-and-olive-oil');
    expect(out).not.toContain('dragee');
  });

  it('every surviving category link resolves to a slug in the live category set', () => {
    const body = [
      '- [Nuts](https://wadyaljuz.com/categories/nuts)',
      '- [Ghost category](https://wadyaljuz.com/categories/does-not-exist)',
      '- [Dried Fruit](https://wadyaljuz.com/categories/dried-fruit)',
    ].join('\n');

    const out = fixCategoryLinks(body, LIVE_CATEGORIES);
    const slugPattern = /category=([a-z0-9-]+)/g;
    const emittedSlugs = [...out.matchAll(slugPattern)].map(m => m[1]);

    expect(emittedSlugs.length).toBeGreaterThan(0);
    for (const slug of emittedSlugs) {
      expect(LIVE_CATEGORIES.some(c => c.slug === slug)).toBe(true);
    }
    expect(out).not.toContain('does-not-exist');
  });

  it('leaves lines with no /categories/ link untouched', () => {
    const body = '# Store\n\n> A description with no links at all.';
    expect(fixCategoryLinks(body, LIVE_CATEGORIES)).toBe(body);
  });

  it('no live categories: every /categories/ line is dropped', () => {
    const body = '- Nuts: https://pecannbee.com.kw/categories/nuts';
    expect(fixCategoryLinks(body, [])).toBe('');
  });
});

describe('buildPerStoreBody — category link shape', () => {
  it('the auto-built body links categories to /products?category=<slug>, never /categories/<slug>', () => {
    const store = { id: 's1', name: 'Wady Aljuz', slug: 'wady-aljuz', domain: 'wadyaljuz.com' };
    const categories = [{ name: 'Nuts', slug: 'nuts' }];
    const body = buildPerStoreBody(store, categories, [], 0);

    expect(body).toContain('https://wadyaljuz.com/products?category=nuts');
    expect(body).not.toContain('/categories/nuts');
  });
});
