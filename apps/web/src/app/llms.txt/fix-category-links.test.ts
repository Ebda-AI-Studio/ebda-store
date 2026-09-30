import { describe, it, expect, vi, afterEach } from 'vitest';
import { fixCategoryLinks, buildPerStoreBody, buildPlatformBody, perStoreResponse } from './route';

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

  it('store genuinely has zero categories: every /categories/ line is dropped', () => {
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

describe('fixCategoryLinks — Arabic slugs (#1854)', () => {
  const AR_CATEGORIES = [{ slug: 'مكسرات' }, { slug: 'nuts-مكسرات' }];

  it('rewrites a fully-Arabic live slug instead of passing the dead link through', () => {
    const out = fixCategoryLinks(
      '- مكسرات: https://pecannbee.com.kw/categories/مكسرات',
      AR_CATEGORIES
    );
    expect(out).toBe(
      `- مكسرات: https://pecannbee.com.kw/products?category=${encodeURIComponent('مكسرات')}`
    );
  });

  it('keeps a mixed ASCII+Arabic live slug instead of dropping the whole line', () => {
    const out = fixCategoryLinks('- [Nuts](https://x.com/categories/nuts-مكسرات)', AR_CATEGORIES);
    expect(out).toBe(
      `- [Nuts](https://x.com/products?category=${encodeURIComponent('nuts-مكسرات')})`
    );
  });

  it('resolves a percent-encoded Arabic slug against the raw live slug', () => {
    const encoded = encodeURIComponent('مكسرات');
    const out = fixCategoryLinks(`- https://x.com/categories/${encoded}`, AR_CATEGORIES);
    expect(out).toBe(`- https://x.com/products?category=${encoded}`);
  });

  it('still drops an Arabic slug that matches no live category', () => {
    expect(fixCategoryLinks('- https://x.com/categories/عسل', AR_CATEGORIES)).toBe('');
  });

  it('the auto-built body encodes an Arabic slug like ProductsPageBody does', () => {
    const store = { id: 's1', name: 'S', slug: 's' };
    const body = buildPerStoreBody(store, [{ name: 'مكسرات', slug: 'مكسرات' }], [], 0);
    expect(body).toContain(`/products?category=${encodeURIComponent('مكسرات')}`);
  });
});

describe('buildPlatformBody — no dead /categories/ route (#1890)', () => {
  it('documents the real category-browse URL, never /<slug>/categories/<cat>', () => {
    const body = buildPlatformBody([]);
    expect(body).not.toMatch(/\/categories\/</);
    expect(body).toContain('/<slug>/products?category=<cat>');
  });
});

describe('perStoreResponse — the served body, not just the builder', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Stub the API: categories endpoint answers `categoriesResponse`, products are empty. */
  function stubApi(categoriesResponse: Response | Error) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/public/categories')) {
          if (categoriesResponse instanceof Error) throw categoriesResponse;
          return categoriesResponse.clone();
        }
        return new Response(JSON.stringify({ data: { products: [] } }), { status: 200 });
      })
    );
  }
  const okCategories = (slugs: string[]) =>
    new Response(
      JSON.stringify({ data: { categories: slugs.map(slug => ({ name: slug, slug })) } }),
      {
        status: 200,
      }
    );

  const override = [
    '# Pecannbee',
    '- Nuts: https://pecannbee.com.kw/categories/nuts',
    '- Dragee: https://pecannbee.com.kw/categories/dragee',
  ].join('\n');
  const store = {
    id: 'store_1',
    name: 'Pecannbee',
    slug: 'pecannbee',
    domain: 'pecannbee.com.kw',
    status: 'active',
    llmsTxt: override,
  };

  // #1853
  it('a categories-API failure leaves the stored body intact and caches it briefly', async () => {
    stubApi(new Response('busy', { status: 503 }));
    const res = await perStoreResponse(store);
    const body = await res.text();
    expect(body).toContain('/categories/nuts');
    expect(body).toContain('/categories/dragee');
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=60');
  });

  it('a network error on the categories fetch is also treated as "could not ask"', async () => {
    stubApi(new Error('ECONNRESET'));
    const body = await (await perStoreResponse(store)).text();
    expect(body).toContain('/categories/dragee');
  });

  it('a successful fetch still repairs the stored body with the long edge TTL', async () => {
    stubApi(okCategories(['nuts']));
    const res = await perStoreResponse(store);
    const body = await res.text();
    expect(body).toContain('https://pecannbee.com.kw/products?category=nuts');
    expect(body).not.toContain('dragee');
    expect(res.headers.get('Cache-Control')).toBe(
      'public, s-maxage=600, stale-while-revalidate=86400'
    );
  });

  // #1667
  it('appends the MCP + x-agent-key contract to a stored llmsTxt when agent_checkout is on', async () => {
    stubApi(okCategories(['nuts']));
    const body = await (
      await perStoreResponse({ ...store, enabledFeatures: ['agent_checkout', 'agent_feed'] })
    ).text();
    expect(body.startsWith('# Pecannbee')).toBe(true);
    expect(body).toContain('## Agentic checkout (MCP)');
    expect(body).toContain('/mcp/pecannbee');
    expect(body).toContain('x-agent-key');
    expect(body).toContain('https://pecannbee.com.kw/feeds/products.json');
  });

  it('does not duplicate the MCP section when the stored text already carries it', async () => {
    stubApi(okCategories(['nuts']));
    const withMcp = `${override}\n\n## Agentic checkout (MCP)\n\n- MCP endpoint: x`;
    const body = await (
      await perStoreResponse({ ...store, llmsTxt: withMcp, enabledFeatures: ['agent_checkout'] })
    ).text();
    expect(body.split('## Agentic checkout (MCP)').length).toBe(2);
  });

  it('leaves a stored llmsTxt unchanged (bar link repair) when neither add-on is enabled', async () => {
    stubApi(okCategories(['nuts']));
    const body = await (await perStoreResponse({ ...store, enabledFeatures: [] })).text();
    expect(body).not.toContain('## Agentic checkout (MCP)');
    expect(body).not.toContain('## Product Feed');
  });
});

// #2131 — each generated section is deduped on its OWN heading.
describe('perStoreResponse — per-section append on a stored override', () => {
  afterEach(() => vi.unstubAllGlobals());
  const okApi = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/public/categories')
          ? new Response(JSON.stringify({ data: { categories: [] } }), { status: 200 })
          : new Response(JSON.stringify({ data: { products: [] } }), { status: 200 })
      )
    );
  const base = { id: 's1', name: 'P', slug: 'p', domain: 'p.example', status: 'active' };
  const count = (body: string, needle: string) => body.split(needle).length - 1;

  it('an override that already documents the feed gets no second ## Product Feed', async () => {
    okApi();
    const llmsTxt = '# P\n\n## Product Feed\n\n- [feed](https://p.example/feeds/products.json)';
    const body = await (
      await perStoreResponse({ ...base, llmsTxt, enabledFeatures: ['agent_feed'] })
    ).text();
    expect(count(body, '## Product Feed')).toBe(1);
  });

  it('an override that already carries the MCP section still receives the feed section', async () => {
    okApi();
    const llmsTxt = '# P\n\n## Agentic checkout (MCP)\n\n- MCP endpoint: x';
    const body = await (
      await perStoreResponse({
        ...base,
        llmsTxt,
        enabledFeatures: ['agent_feed', 'agent_checkout'],
      })
    ).text();
    expect(count(body, '## Agentic checkout (MCP)')).toBe(1);
    expect(count(body, '## Product Feed')).toBe(1);
    expect(body).toContain('https://p.example/feeds/products.json');
  });
});

// #2224 — the AUTO-BUILT body enumerates categories and products, so a failed
// fetch of either must not publish "0 categories" / "0 products".
describe('perStoreResponse — auto-build under a failed upstream fetch', () => {
  afterEach(() => vi.unstubAllGlobals());
  const store = { id: 's1', name: 'P', slug: 'p', domain: 'p.example', status: 'active' };
  function stub(opts: { categories: 'ok' | 'fail'; products: 'ok' | 'fail' | 'fail-page-2' }) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/public/categories')) {
          return opts.categories === 'ok'
            ? new Response(
                JSON.stringify({ data: { categories: [{ name: 'Nuts', slug: 'nuts' }] } })
              )
            : new Response('busy', { status: 503 });
        }
        if (opts.products === 'fail') return new Response('busy', { status: 429 });
        if (opts.products === 'fail-page-2' && u.includes('page=2')) {
          return new Response('busy', { status: 503 });
        }
        const n = opts.products === 'fail-page-2' && u.includes('page=1') ? 100 : 1;
        const products = Array.from({ length: n }, (_, i) => ({
          name: `Item ${i}`,
          slug: `item-${i}`,
          price: 1000,
        }));
        return new Response(JSON.stringify({ data: { products } }));
      })
    );
  }

  it('categories could not be asked → 503 + Retry-After, never "Categories (0)"', async () => {
    stub({ categories: 'fail', products: 'ok' });
    const res = await perStoreResponse(store);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).not.toContain('## Categories (0)');
  });

  it('products could not be asked → 503, never "Products (0 total"', async () => {
    stub({ categories: 'ok', products: 'fail' });
    const res = await perStoreResponse(store);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('Products (0 total');
  });

  it('a later products page failing is not published as a short, "complete" list', async () => {
    stub({ categories: 'ok', products: 'fail-page-2' });
    const res = await perStoreResponse(store);
    expect(res.status).toBe(503);
  });

  it('both fetched → 200 with the long edge TTL (control)', async () => {
    stub({ categories: 'ok', products: 'ok' });
    const res = await perStoreResponse(store);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('## Categories (1)');
    expect(body).toContain('## Products (1 total, showing 1)');
    expect(res.headers.get('Cache-Control')).toBe(
      'public, s-maxage=600, stale-while-revalidate=86400'
    );
  });
});
