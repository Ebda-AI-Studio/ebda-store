import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { getSiteUrl } from '../lib/structured-data';
import { API_URL } from '../lib/api';

// Static page slugs that exist for every store (per-tenant rewrite).
const STORE_STATIC_PAGES: Array<{ path: string; priority: number; freq: 'monthly' | 'weekly' }> = [
  { path: '', priority: 1.0, freq: 'weekly' }, // store home
  { path: '/products', priority: 0.9, freq: 'weekly' },
  { path: '/categories', priority: 0.8, freq: 'weekly' },
  { path: '/about', priority: 0.5, freq: 'monthly' },
  { path: '/contact', priority: 0.5, freq: 'monthly' },
  { path: '/faq', priority: 0.4, freq: 'monthly' },
  { path: '/how-to-guides', priority: 0.5, freq: 'monthly' },
  { path: '/shipping', priority: 0.4, freq: 'monthly' },
  { path: '/returns', priority: 0.4, freq: 'monthly' },
  { path: '/privacy', priority: 0.3, freq: 'monthly' },
  { path: '/terms', priority: 0.3, freq: 'monthly' },
];

type StoreListEntry = {
  id: string;
  slug: string;
  /** ISO timestamp from /public/stores — used to pick which stores get
   *  product fan-out (oldest first) when the store count exceeds the cap. */
  createdAt?: string;
};

type ProductEntry = {
  slug: string;
  updatedAt?: string;
  createdAt?: string;
};

const STORE_LIST_PAGE_SIZE = 100;
const STORE_LIST_MAX_PAGES = 50;

/**
 * Page through the public store list. Both early exits are LOGGED (#1815):
 * the page ceiling and a mid-pagination failure used to return a short list
 * silently, and every downstream drop count was computed from that short
 * list, so "did any store vanish?" had no truthful answer in the logs.
 * `storesNeverFetched` is the number of stores the API reported that this
 * render never received (an estimate from `totalPages`, exact to one page).
 */
async function fetchStores(): Promise<{
  stores: StoreListEntry[];
  storesNeverFetched: number;
}> {
  const stores: StoreListEntry[] = [];
  let page = 1;
  let totalPages = 1;
  while (true) {
    const res = await fetch(`${API_URL}/public/stores?page=${page}&limit=${STORE_LIST_PAGE_SIZE}`, {
      next: { revalidate: 3600 },
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      console.error('sitemap: store list fetch failed mid-pagination', {
        page,
        status: res.status,
        fetchedSoFar: stores.length,
      });
      // Page 1 failing means we know nothing about the total; a later page
      // failing leaves the remaining pages' stores unfetched.
      return {
        stores,
        storesNeverFetched:
          page === 1 ? 0 : Math.max(0, totalPages * STORE_LIST_PAGE_SIZE - stores.length),
      };
    }
    const data = await res.json();
    const batch: StoreListEntry[] = data?.data ?? [];
    stores.push(...batch.map(s => ({ id: s.id, slug: s.slug, createdAt: s.createdAt })));
    totalPages = data?.pagination?.totalPages ?? 1;
    if (page >= totalPages) break;
    // Hard cap so a runaway DB can't blow the sitemap timeout.
    if (page >= STORE_LIST_MAX_PAGES) {
      console.error('sitemap: store list page ceiling hit', {
        fetchedPages: STORE_LIST_MAX_PAGES,
        fetched: stores.length,
        totalPages,
      });
      return {
        stores,
        storesNeverFetched: Math.max(0, totalPages * STORE_LIST_PAGE_SIZE - stores.length),
      };
    }
    page += 1;
  }
  return { stores, storesNeverFetched: 0 };
}

/**
 * Resolve a custom-domain host (e.g. `wadyaljuz.com`) to its owning
 * store via the dedicated /public/store/resolve endpoint. Returns null
 * when the host isn't a known custom domain (e.g. platform path,
 * preview deploy host, direct IP hit).
 */
async function resolveStoreByHost(host: string): Promise<StoreListEntry | null> {
  if (!host) return null;
  try {
    const res = await fetch(`${API_URL}/public/store/resolve`, {
      next: { revalidate: 3600 },
      headers: { 'Content-Type': 'application/json', 'x-store-domain': host },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const store = data?.data?.store;
    if (!store?.id || !store?.slug) return null;
    return { id: store.id, slug: store.slug };
  } catch {
    return null;
  }
}

/**
 * Fetch a store's published products, paginated. The API hard-clamps
 * `limit` at 100 (`ProductService.listPublic`: `Math.min(100, ...)`) — the
 * old single `?limit=1000` request silently got page 1 of 100, so any
 * catalog past 100 products was absent from the sitemap (audit-followup
 * #1147/#1163; live-verified: pecannbee returned 100 of 160). Loop pages at
 * the real clamp until `meta.totalPages` is exhausted, bounded by
 * `maxPages` so the master branch's fan-out can't blow the Worker's
 * 1000-subrequest ceiling. Truncation past the bound is logged, never
 * silent.
 */
async function fetchProducts(storeId: string, maxPages: number): Promise<ProductEntry[]> {
  const products: ProductEntry[] = [];
  let page = 1;
  while (page <= maxPages) {
    const res = await fetch(
      `${API_URL}/public/products?page=${page}&limit=100&status=published&storeId=${storeId}`,
      {
        // The 1-hour TTL is the floor, not the control: the tag lets a product
        // save refresh the sitemap immediately instead of up to an hour later.
        // Kept from main — the pagination rewrite on this branch dropped it,
        // and taking either side of the conflict whole would have lost one of
        // the two fixes.
        next: { revalidate: 3600, tags: [`products:${storeId}`] },
        headers: { 'Content-Type': 'application/json', 'X-Store-ID': storeId },
      }
    );
    if (!res.ok) break;
    const data = await res.json();
    // Keep only the three fields the sitemap reads (#1290). The API returns
    // the full storefront payload (descriptions, images, variants, store) —
    // retaining it for up to 200 stores x 300 products is what pushes a
    // master render toward the Worker's 128 MB isolate limit.
    const batch: ProductEntry[] = data?.data?.products ?? [];
    for (const p of batch) {
      products.push({ slug: p.slug, updatedAt: p.updatedAt, createdAt: p.createdAt });
    }
    const totalPages = data?.data?.meta?.totalPages ?? 1;
    if (page >= totalPages) break;
    if (page === maxPages && totalPages > maxPages) {
      console.warn('sitemap: product pagination capped for store', {
        storeId,
        fetchedPages: maxPages,
        totalPages,
      });
    }
    page += 1;
  }
  return products;
}

type BundleEntry = { slug: string };

/**
 * Fetch a store's purchasable bundles for the sitemap. Unlike
 * `fetchProducts`, this is deliberately a SINGLE, unpaginated request:
 * `GET /stores/public/:storeId/bundles` (bundle.routes.ts) has no `limit`
 * param and no pagination — a merchant hand-curates a small set of bundles
 * (see that route's own doc comments), so one request per store is already
 * bounded, unlike an unbounded product dump would be. `bundles` is in NO
 * plan baseline (see plan-baselines.ts), so for the overwhelming majority
 * of stores this 403s (`FEATURE_DISABLED`) and resolves to `[]` — that's
 * the expected, non-exceptional case here, so (unlike the product
 * pagination cap above) it is NOT logged.
 */
async function fetchBundles(storeId: string): Promise<BundleEntry[]> {
  try {
    const res = await fetch(`${API_URL}/stores/public/${storeId}/bundles`, {
      next: { revalidate: 3600, tags: [`products:${storeId}`] },
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const bundles: BundleEntry[] = data?.data?.bundles ?? [];
    return bundles.map(b => ({ slug: b.slug })); // slug is all the sitemap reads (#1290)
  } catch {
    return [];
  }
}

/**
 * Sitemap with host-aware tenant fan-out.
 *
 * The same Next.js sitemap route serves three different audiences
 * depending on the host header:
 *
 *   - `wadyaljuz.com` (custom domain)
 *     → ONLY Wady Aljuz's URLs, rooted at https://wadyaljuz.com
 *     → submitted to Google Search Console for that merchant's property
 *   - `store.forcemediakw.com` (platform path)
 *     → master sitemap covering every store under /<slug>/, rooted
 *       at https://store.forcemediakw.com
 *     → submitted to the platform's GSC property
 *   - any other host (preview deploys, IP-direct hits)
 *     → falls through to the master sitemap shape with whatever
 *       `getSiteUrl()` decides
 *
 * Without the host branch, the sitemap at wadyaljuz.com/sitemap.xml
 * would list `https://store.forcemediakw.com/wady-aljuz/...` URLs,
 * which causes Google to index the wrong domain when the merchant
 * submits their own GSC property. Caught on wadyaljuz.com 2026-05-14.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const requestHost = (await headers()).get('host')?.toLowerCase() ?? '';

  // Tenant branch: ask the API whether this host is a known custom
  // domain. Avoids exposing the domain list via /public/stores. Falls
  // through to the master sitemap on a non-match (platform path,
  // preview deploys, etc.).
  const tenant = await resolveStoreByHost(requestHost);
  if (tenant) {
    const base = `https://${requestHost}`;
    // Single store, own domain: up to 10 pages x 100 = 1000 product URLs,
    // plus 1 unpaginated bundle-list request (see fetchBundles) — 12
    // subrequests worst case, nowhere near any Worker limit.
    const [products, bundles] = await Promise.all([
      fetchProducts(tenant.id, 10).catch(() => [] as ProductEntry[]),
      fetchBundles(tenant.id),
    ]);
    const entries: MetadataRoute.Sitemap = [];
    for (const page of STORE_STATIC_PAGES) {
      entries.push({
        url: `${base}${page.path || '/'}`,
        lastModified: now,
        changeFrequency: page.freq,
        priority: page.priority,
      });
    }
    for (const product of products) {
      entries.push({
        url: `${base}/products/${product.slug}`,
        lastModified: product.updatedAt
          ? new Date(product.updatedAt)
          : product.createdAt
            ? new Date(product.createdAt)
            : now,
        changeFrequency: 'weekly',
        priority: 0.7,
      });
    }
    // No `updatedAt` on the bundle-list response (it's the pre-filtered,
    // customer-facing shape — see PublicBundle) — `now` is an acceptable
    // freshness signal for a merchant-curated set this small.
    //
    // The `/bundles` index itself is NOT in `STORE_STATIC_PAGES` (unlike
    // `/products`/`/categories`, which every store has) — it 404s for a
    // store without the `bundles` feature (see `BundlesPageBody`'s
    // 403-means-404 treatment), so it's only listed when `bundles` is
    // non-empty, exactly like the ShopChrome nav entry's own gating.
    if (bundles.length > 0) {
      entries.push({
        url: `${base}/bundles`,
        lastModified: now,
        changeFrequency: 'weekly',
        priority: 0.6,
      });
    }
    for (const bundle of bundles) {
      entries.push({
        url: `${base}/bundles/${bundle.slug}`,
        lastModified: now,
        changeFrequency: 'weekly',
        priority: 0.6,
      });
    }
    return entries;
  }

  // Master sitemap: platform path. Covers every store under /<slug>/...
  //
  // The platform root itself is NOT listed (#1543): `${siteUrl}/` 307s to the
  // Force AI company site (HomePageBody's demo-store redirect), and a
  // sitemap URL that redirects is reported by GSC as "Page with redirect".
  const siteUrl = getSiteUrl();

  let stores: StoreListEntry[] = [];
  let storesNeverFetched = 0;
  try {
    ({ stores, storesNeverFetched } = await fetchStores());
  } catch (error) {
    console.error('sitemap: failed to fetch stores', error);
    return [];
  }

  // Bounded fan-out. `fetchStores()` pages up to 50x100 = 5000 stores, and one
  // subrequest per store in a single Worker invocation would blow Cloudflare's
  // 1000-subrequest ceiling as the platform grows — the render would throw past
  // it and fail the whole render. Cap the
  // per-render fan-out and emit the remaining stores with their static pages
  // only (their 11 static pages still get indexed; their catalogs don't
  // contribute product URLs to this render) — a promise the 50k clamp used to
  // break, because it cut the tail of a store-by-store list and starved every
  // store past the budget of everything. Static pages are emitted in their own
  // pass now, so this is true again. Chunked rather than one Promise.all so we
  // also stop opening 200 sockets at once against the API.
  //
  // Subrequest budget (worst case, #1271): 50 store-list pages + 1 host
  // resolve + 200 stores x (3 product pages + 1 unpaginated bundle-list
  // request) = 851 fetch() calls. That is NOT the whole bill: Cloudflare
  // counts calls to its own services via bindings as subrequests too
  // (developers.cloudflare.com/workers/platform/limits/#subrequests), and
  // every one of these fetches carries `next.revalidate`, so OpenNext's R2
  // incremental cache adds a get (+ a put on a cold/expired entry) and the
  // Durable-Object tag cache a lookup per fetch — roughly 4 x 851 ≈ 3,400 on
  // a fully cold render. The ceiling this is measured against is the Workers
  // Paid default of 10,000 per invocation (raised from 1,000 on 2026-02-11;
  // no `limits.subrequests` override in wrangler.jsonc). Memory is bounded
  // separately: fetchProducts keeps only slug/updatedAt/createdAt per product.
  // A store whose fan-out throws (e.g. a subrequest-limit error) degrades to
  // static pages only and is COUNTED in the log below, never silently.
  const MAX_STORES_WITH_PRODUCTS = 200;
  const PRODUCT_PAGES_PER_STORE = 3; // x100 = up to 300 product URLs per store
  const FANOUT_CHUNK = 20;

  // /public/stores returns newest-first (`orderBy createdAt desc`), so a
  // positional slice used to keep the 200 NEWEST stores and silently drop
  // product URLs for every older one — the longest-tenured, largest-catalog
  // anchor tenants lost their catalogs first while brand-new (possibly
  // empty) stores kept theirs (audit-followup #1146/#1162). Select
  // oldest-first for the product fan-out instead: deterministic, and
  // priority-correct for accumulated SEO equity.
  const byOldestFirst = [...stores].sort((a, b) =>
    (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
  );
  const withProducts = byOldestFirst.slice(0, MAX_STORES_WITH_PRODUCTS);
  const withoutProducts = byOldestFirst.slice(MAX_STORES_WITH_PRODUCTS);
  if (withoutProducts.length > 0) {
    // No-silent-caps rule: the drop must be observable in Worker logs.
    console.warn('sitemap: product fan-out capped', {
      total: stores.length,
      withProducts: withProducts.length,
      dropped: withoutProducts.length,
    });
  }

  let fanoutFailures = 0;
  const productResults: Array<{
    store: StoreListEntry;
    products: ProductEntry[];
    bundles: BundleEntry[];
  }> = [];
  for (let i = 0; i < withProducts.length; i += FANOUT_CHUNK) {
    const chunk = withProducts.slice(i, i + FANOUT_CHUNK);
    productResults.push(
      ...(await Promise.all(
        chunk.map(store =>
          Promise.all([fetchProducts(store.id, PRODUCT_PAGES_PER_STORE), fetchBundles(store.id)])
            .then(([products, bundles]) => ({ store, products, bundles }))
            .catch(() => {
              fanoutFailures += 1;
              return { store, products: [] as ProductEntry[], bundles: [] as BundleEntry[] };
            })
        )
      ))
    );
  }
  if (fanoutFailures > 0) {
    console.error('sitemap: product fan-out failed for some stores — static pages only', {
      failedStores: fanoutFailures,
      attempted: withProducts.length,
    });
  }
  for (const store of withoutProducts) {
    productResults.push({ store, products: [], bundles: [] });
  }

  // TWO passes, not one interleaved pass.
  //
  // The 50k clamp below cuts the TAIL, and `perTenant` used to be built
  // store-by-store — all of one store's URLs, then all of the next's. A
  // product-bearing store emits up to 11 static + 300 product + bundle URLs,
  // so ~161 full-catalog stores consume the entire 50,000 budget on their own
  // and every store after them is emitted with ZERO URLs. Not "their 11 static
  // pages still get indexed", which is what the comment above and the GSC
  // runbook both promised: newer tenants vanish from the master sitemap
  // outright rather than degrading to static-page-only coverage.
  //
  // Static pages first for EVERY store — that pass is cheap and bounded at
  // 11 x N, so it cannot starve anyone — then product and bundle URLs until
  // the budget runs out. Now only catalog DEPTH degrades, which is the
  // behaviour that was documented all along.
  const staticPages: MetadataRoute.Sitemap = [];
  const catalogPages: MetadataRoute.Sitemap = [];
  for (const { store } of productResults) {
    for (const page of STORE_STATIC_PAGES) {
      staticPages.push({
        url: `${siteUrl}/${store.slug}${page.path}`,
        lastModified: now,
        changeFrequency: page.freq,
        priority: page.priority,
      });
    }
  }
  for (const { store, products, bundles } of productResults) {
    for (const product of products) {
      catalogPages.push({
        url: `${siteUrl}/${store.slug}/products/${product.slug}`,
        lastModified: product.updatedAt
          ? new Date(product.updatedAt)
          : product.createdAt
            ? new Date(product.createdAt)
            : now,
        changeFrequency: 'weekly',
        priority: 0.7,
      });
    }
    // Same gating as the tenant branch above: `/bundles` only listed when
    // this store actually has purchasable bundles.
    if (bundles.length > 0) {
      catalogPages.push({
        url: `${siteUrl}/${store.slug}/bundles`,
        lastModified: now,
        changeFrequency: 'weekly',
        priority: 0.6,
      });
    }
    for (const bundle of bundles) {
      catalogPages.push({
        url: `${siteUrl}/${store.slug}/bundles/${bundle.slug}`,
        lastModified: now,
        changeFrequency: 'weekly',
        priority: 0.6,
      });
    }
  }

  const perTenant: MetadataRoute.Sitemap = [...staticPages, ...catalogPages];

  // Sitemap protocol hard limit: 50,000 URLs per file (sitemaps.org) —
  // past it Google reports an error and processes at most the first 50k.
  // With 11 static pages per store, a full 5000-store fetch alone would
  // emit 55,001 URLs, so clamp and log rather than ship an invalid
  // document (audit-followup #1148/#1164). Product-bearing (oldest/anchor)
  // stores are emitted first, so the clamp drops the newest stores' static
  // pages last. The real fix past ~4,500 stores is sharding — but NOT via
  // Next's `generateSitemaps()`, which remaps the route to
  // `/sitemap/[id].xml` and 404s the bare `/sitemap.xml` every merchant
  // has already submitted to GSC (verified against next@16.2.6's
  // metadata-route loader; Next generates no sitemap index file).
  const SITEMAP_URL_LIMIT = 50_000;
  const entries = perTenant;
  if (entries.length > SITEMAP_URL_LIMIT) {
    // Report how many stores got NOTHING, not just the total.
    //
    // A total alone tells an operator that truncation happened; it does not
    // tell them anyone vanished. With static pages emitted first, a store is
    // fully dropped only once even the cheap 11-per-store pass overflows —
    // which is the point past which the sitemap genuinely cannot represent the
    // platform and sharding is the real answer.
    const staticBudget = SITEMAP_URL_LIMIT;
    const storesFullyDropped = Math.max(
      0,
      productResults.length - Math.floor(staticBudget / STORE_STATIC_PAGES.length)
    );
    console.error('sitemap: master sitemap exceeds the 50k-URL protocol limit — truncating', {
      total: entries.length,
      emitted: SITEMAP_URL_LIMIT,
      stores: stores.length,
      storesFullyDropped,
      // Stores the API reported but fetchStores() never received — see its
      // own error log for why. Absent from `stores` above entirely.
      storesNeverFetched,
      catalogUrlsDropped: Math.min(catalogPages.length, entries.length - SITEMAP_URL_LIMIT),
    });
    return entries.slice(0, SITEMAP_URL_LIMIT);
  }
  return entries;
}
