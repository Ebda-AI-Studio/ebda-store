/**
 * Full-catalogue feeds (Ruling FEEDS-4): keyset pagination past 100 products, split into parts, and the NEVER-stale cache
 * contract: a price write that calls invalidateStoreProductCaches (every write path does) is visible on the very next
 * fetch, with the REAL cache wrapper over an in-memory Redis.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const kv = vi.hoisted(() => new Map<string, string>());
const gens = vi.hoisted(() => new Map<string, number>());
const redisMock = vi.hoisted(() => ({
  get: vi.fn(async (k: string) => kv.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => {
    kv.set(k, v);
  }),
  delete: vi.fn(async (k: string) => {
    kv.delete(k);
  }),
  deleteByPattern: vi.fn(async (prefix: string) => {
    for (const k of [...kv.keys()]) if (k.startsWith(prefix)) kv.delete(k);
    return 0;
  }),
  isAvailable: vi.fn(() => true),
  getCacheGenerations: vi.fn(async (names: string[]) => names.map(n => String(gens.get(n) ?? 0))),
  bumpCacheGeneration: vi.fn(async (n: string) => {
    gens.set(n, (gens.get(n) ?? 0) + 1);
  }),
}));
vi.mock('@api/services/redis.service', () => ({ redis: redisMock }));
vi.mock('@api/lib/revalidate-storefront', () => ({ revalidateStorefront: vi.fn() }));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/services/bundle.service', () => ({
  listSellableBundles: vi.fn(async () => []),
  describeBundleContents: vi.fn(() => ({})),
  withinSaleWindow: vi.fn(() => true),
}));

const db = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; price: number; variants: number }>,
  reads: 0,
}));
vi.mock('@api/lib/repo-factory', () => {
  const mk = (r: { id: string; price: number; variants: number }) => ({
    id: r.id,
    name: `P ${r.id}`,
    nameAr: null,
    slug: r.id,
    description: 'd',
    descriptionAr: null,
    excerpt: null,
    excerptAr: null,
    price: r.price,
    compareAtPrice: null,
    sku: null,
    barcode: null,
    inventory: 3,
    trackInventory: true,
    allowBackorder: false,
    weight: null,
    facts: [],
    images: [{ url: `https://cdn.example/${r.id}.jpg`, position: 0 }],
    categories: [],
    options: [],
    variants: Array.from({ length: r.variants }, (_, i) => ({
      id: `${r.id}-v${i}`,
      title: `V${i}`,
      titleAr: null,
      sku: null,
      barcode: null,
      price: null,
      compareAtPrice: null,
      inventory: 2,
      allowBackorder: false,
      isActive: true,
      weight: null,
      imageUrl: null,
    })),
  });
  return {
    storeDb: async () => ({
      product: {
        findMany: async (a: { where: { id?: { gt: string } }; take: number }) => {
          db.reads++;
          const after = a.where.id?.gt;
          return db.rows
            .filter(r => !after || r.id > after)
            .slice(0, a.take)
            .map(mk);
        },
        count: async () => 0,
      },
      productVariantOption: { findMany: async () => [] },
      store: {
        findUniqueOrThrow: async () => ({
          id: 's1',
          name: 'Shop',
          nameAr: null,
          slug: 'shop',
          currency: 'EGP',
          domain: null,
        }),
      },
      shippingZone: { findMany: async () => [] },
      shippingAreaRate: { findMany: async () => [] },
      category: { findMany: async () => [] },
    }),
  };
});

import { renderFeed, PART_ITEMS } from '@api/lib/catalogue-feed/service';
import { invalidateStoreProductCaches } from '@api/lib/public-cache';

const ids = (xml: string) => [...xml.matchAll(/<g:id>([^<]+)<\/g:id>/g)].map(m => m[1]);
const render = (part = 1, backorderOn = false) =>
  renderFeed({
    storeId: 's1',
    platform: 'google',
    lang: 'en',
    part,
    backorderOn,
    bundlesEnabled: false,
  });
const padId = (i: number) => `p${String(i).padStart(5, '0')}`;

beforeEach(() => {
  kv.clear();
  gens.clear();
  db.reads = 0;
  vi.clearAllMocks();
});

describe('pagination past 100', () => {
  it('250 products -> 250 items, read in 100-product keyset chunks', async () => {
    db.rows = Array.from({ length: 250 }, (_, i) => ({ id: padId(i), price: 1000, variants: 0 }));
    const doc = (await render())!;
    expect(ids(doc.body)).toHaveLength(250);
    expect(new Set(ids(doc.body)).size).toBe(250);
    expect(doc.nextPart).toBeNull();
    expect(db.reads).toBe(3);
  });

  it('a catalogue over one part is split on a product boundary; parts are disjoint and complete; no part 3', async () => {
    // 2600 products x 2 variants = 5200 items > PART_ITEMS
    db.rows = Array.from({ length: 2600 }, (_, i) => ({ id: padId(i), price: 1000, variants: 2 }));
    const p1 = (await render(1))!;
    const p2 = (await render(2))!;
    expect(p1.nextPart).toBe(2);
    expect(p2.nextPart).toBeNull();
    const a = ids(p1.body),
      b = ids(p2.body);
    expect(a.length).toBeGreaterThanOrEqual(PART_ITEMS);
    expect(a.length + b.length).toBe(5200);
    expect(new Set([...a, ...b]).size).toBe(5200);
    expect(await render(3)).toBeNull();
    // variants are items with their own id; the group is the product
    expect(a[0]).toBe('p00000-v0');
    expect(p1.body).toContain('<g:item_group_id>p00000</g:item_group_id>');
  });
});

describe('cache: NEVER-stale price across every write path', () => {
  it('a price change is served stale until invalidateStoreProductCaches, then fresh', async () => {
    db.rows = [{ id: 'p00001', price: 10000, variants: 0 }];
    expect((await render())!.body).toContain('<g:price>100.00 EGP</g:price>');
    db.rows = [{ id: 'p00001', price: 12000, variants: 0 }];
    expect((await render())!.body).toContain('<g:price>100.00 EGP</g:price>'); // cached: proves the cache is real
    await invalidateStoreProductCaches('s1');
    const fresh = (await render())!.body;
    expect(fresh).toContain('<g:price>120.00 EGP</g:price>');
    expect(fresh).not.toContain('100.00 EGP');
  });

  it('the backorder entitlement is part of the key: flipping it never serves the other state', async () => {
    db.rows = [{ id: 'p00001', price: 10000, variants: 0 }];
    db.rows = db.rows.map(r => ({ ...r }));
    const off = (await render(1, false))!.body;
    const on = (await render(1, true))!.body;
    expect(off).toContain('in_stock');
    expect(on).toContain('in_stock');
    // distinct cache entries (bo0 / bo1)
    expect(
      [...kv.keys()]
        .filter(k => k.includes(':feedx:v1:google:en:'))
        .sort()
        .map(k => k.split(':').slice(-2)[0])
    ).toEqual(['bo0', 'bo1']);
  });

  it('a miss that finds no such part is not cached', async () => {
    db.rows = [{ id: 'p00001', price: 10000, variants: 0 }];
    expect(await render(2)).toBeNull();
    expect([...kv.keys()].some(k => k.endsWith(':2'))).toBe(false);
  });
});
