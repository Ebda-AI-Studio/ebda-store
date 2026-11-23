import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { resolveDefaultLanguage } from '@ebda/shared';
import { API_URL } from '../lib/api';
import { hidesFromSearch } from '../lib/hide-from-search';
import { resolveStoreByDomain, StoreTemporarilyUnavailableError } from '../lib/store-resolver';
import {
  localePathsOn,
  localeAlternates,
  prefixedPath,
  storeKeyForHost,
  type PathLocale,
} from '../lib/locale-paths';

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
  /** The demo showroom (Ruling B1-14): listed nowhere. */
  isDemo?: boolean;
  /** The merchant switched on "hide from search engines": nothing to submit. */
  hidden?: boolean;
  /** `settings.defaultLanguage`: the x-default of a store that has language-in-URL ON (LOCALE-PATHS-1). */
  defaultLanguage?: string;
};

type ProductEntry = {
  slug: string;
  updatedAt?: string;
  createdAt?: string;
};

/**
 * The API that a sitemap enumerates could not be asked (#2127). Thrown rather
 * than degraded to an empty list: a 200 with an empty `<urlset/>` makes Google
 * Search Console record "0 discovered URLs" and replace its last-good state,
 * while a 5xx makes it retry and keep the previous sitemap. "Could not ask" is
 * kept distinct from a genuinely empty answer (zero stores / zero products),
 * the same contract `fetchCategories` in llms.txt/route.ts follows.
 */
class SitemapSourceUnavailableError extends Error {
  constructor(detail: string) {
    super(`sitemap source unavailable: ${detail}`);
    this.name = 'SitemapSourceUnavailableError';
  }
}
/**
 * Resolve a custom-domain host (e.g. `demo-shop.example`) to its owning
 * store via the dedicated /public/store/resolve endpoint. Returns null
 * when the host isn't a known custom domain (e.g. platform path,
 * preview deploy host, direct IP hit).
 */
async function resolveStoreByHost(host: string): Promise<StoreListEntry | null> {
  if (!host) return null;
  // R1 (2026-11-17): this used to call `/public/store/resolve` with a bare fetch, so a cold API (3-8 s, or a 429 / 5xx on the
  // first hit after an idle gap) failed the render with a 500 on a custom domain's FIRST sitemap request, while the nine
  // that followed were fine. The storefront's own resolver is the one owner of host resolution (Ruling
  // RESOLVE-BULLETPROOF-1): memory + durable last-known-good copy (epoch-checked, so a purged or suspended store is never
  // served), one retry, stale-if-error. A definitive 404 still means "no store owns this host" (null); "could not ask" is
  // still a failed render, never an empty or platform sitemap (#2127), and the edge answers it 503 + Retry-After.
  try {
    const store = await resolveStoreByDomain(host);
    if (!store) return null;
    if (!store.id || !store.slug) return null;
    return {
      id: store.id,
      slug: store.slug,
      isDemo: store.isDemo === true,
      hidden: hidesFromSearch(store),
      defaultLanguage: (store.settings as { defaultLanguage?: string } | undefined)
        ?.defaultLanguage,
    };
  } catch (error) {
    if (error instanceof SitemapSourceUnavailableError) throw error;
    const detail =
      error instanceof StoreTemporarilyUnavailableError ? error.message : 'network error';
    throw new SitemapSourceUnavailableError(`host resolve → ${detail}`);
  }
}

/**
 * Fetch a store's published products, paginated. The API hard-clamps
 * `limit` at 100 (`ProductService.listPublic`: `Math.min(100, ...)`) — the
 * old single `?limit=1000` request silently got page 1 of 100, so any
 * catalog past 100 products was absent from the sitemap (audit-followup
 * #1147/#1163; live-verified: demo-store returned 100 of 160). Loop pages at
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
    if (!res.ok) {
      // Page 1 is "could not ask" — the caller decides (the tenant branch
      // fails the render; the master fan-out degrades that one store to
      // static pages and counts it). A later page keeps what was fetched.
      if (page === 1) {
        throw new SitemapSourceUnavailableError(`products page 1 → HTTP ${res.status}`);
      }
      break;
    }
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
 * The custom-domain branch of `sitemap()`: ONE store's URLs, rooted at its
 * own host (see `sitemap()`'s doc comment for why). Extracted unchanged from
 * `sitemap()` (issue 1549) — tests/unit/sitemap-fanout.test.ts covers both
 * branches.
 */
async function buildTenantSitemap(
  requestHost: string,
  storeId: string,
  now: Date,
  /** The store's default language when it has language-in-URL ON (LOCALE-PATHS-1), else undefined. */
  localeDefault?: PathLocale
): Promise<MetadataRoute.Sitemap> {
  const base = `https://${requestHost}`;
  /** One URL per language, each naming both (and x-default) when the store has locale paths; else the one URL. */
  const pageEntries = (
    path: string,
    lastModified: Date,
    changeFrequency: 'weekly' | 'monthly',
    priority: number
  ): MetadataRoute.Sitemap => {
    if (!localeDefault)
      return [{ url: `${base}${path || '/'}`, lastModified, changeFrequency, priority }];
    return (['ar', 'en'] as const).map(locale => ({
      url: `${base}${prefixedPath(locale, path || '/')}`,
      lastModified,
      changeFrequency,
      priority,
      alternates: {
        languages: localeAlternates({ origin: base, path, locale, defaultLocale: localeDefault })
          .languages,
      },
    }));
  };
  // Single store, own domain: up to 10 pages x 100 = 1000 product URLs,
  // plus 1 unpaginated bundle-list request (see fetchBundles) — 12
  // subrequests worst case, nowhere near any Worker limit.
  const [products, bundles] = await Promise.all([
    // No catch (#2127): a products outage must 5xx this merchant's own
    // sitemap, not publish it with every product URL missing.
    fetchProducts(storeId, 10),
    fetchBundles(storeId),
  ]);
  const entries: MetadataRoute.Sitemap = [];
  for (const page of STORE_STATIC_PAGES) {
    entries.push(...pageEntries(page.path, now, page.freq, page.priority));
  }
  for (const product of products) {
    entries.push(
      ...pageEntries(
        `/products/${product.slug}`,
        product.updatedAt
          ? new Date(product.updatedAt)
          : product.createdAt
            ? new Date(product.createdAt)
            : now,
        'weekly',
        0.7
      )
    );
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

/**
 * Per-store sitemap, keyed on the request HOST.
 *
 * Every store has its own host, and `/sitemap.xml` on that host lists ONLY that
 * store's URLs, rooted at that host:
 *
 *   - `amelia.ebda.app` / `demo-shop.example` (a store host)
 *     → ONLY that store's URLs, submitted to that merchant's GSC property
 *   - `ebda.app` and other platform hosts
 *     → no store, nothing to list: an empty sitemap (the marketing site owns
 *       its own). There is NO master sitemap fanning out over every store under
 *       `/<slug>/…` — that path-based layout is gone.
 *   - a store host that resolves to no store
 *     → 404, never another store's URLs
 *   - the demo showroom (`isDemo`) or a store hidden from search engines → an empty sitemap (noindex, Ruling B1-14)
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  // `x-store-domain` is the canonical request host, asserted by middleware for
  // `<slug>.ebda.app` and custom domains and ABSENT on platform hosts.
  const storeHost = (await headers()).get('x-store-domain')?.toLowerCase() ?? '';
  if (!storeHost) return [];

  // Ask the API which store owns this host. A definitive miss is a 404; "could
  // not ask" throws (SitemapSourceUnavailableError → 5xx, so Google keeps its
  // last-good copy).
  const tenant = await resolveStoreByHost(storeHost);
  if (!tenant) notFound();
  // The demo showroom is noindex (Ruling B1-14): nothing to submit.
  // A store hidden from search engines by its merchant lists no URLs either.
  if (tenant.isDemo || tenant.hidden) return [];
  return buildTenantSitemap(
    storeHost,
    tenant.id,
    now,
    localePathsOn(storeKeyForHost(storeHost))
      ? resolveDefaultLanguage(tenant.defaultLanguage)
      : undefined
  );
}
