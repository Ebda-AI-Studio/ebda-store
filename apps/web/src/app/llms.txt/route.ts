import { headers } from 'next/headers';
import { API_URL } from '../../lib/api';

/**
 * Dynamic /llms.txt — served at two levels:
 *
 *   store.forcemediakw.com/llms.txt
 *     → platform-level index: lists every active merchant with a one-liner
 *       + a structure map for AI crawlers. No store context in headers.
 *
 *   store.forcemediakw.com/<slug>/llms.txt
 *     → middleware rewrites to /llms.txt + sets x-store-slug header.
 *       Route detects the slug, fetches that store's categories + products
 *       + contact info, renders a per-store markdown index.
 *
 * All data is fetched from the public API (no direct Prisma — the web app
 * doesn't depend on @force/database).
 */

// ---------------------------------------------------------------------------
// Types (minimal — only the fields we actually use)
// ---------------------------------------------------------------------------

interface PublicStore {
  id: string;
  name: string;
  nameAr?: string;
  slug: string;
  description?: string;
  email?: string;
  phone?: string;
  address?: string;
  domain?: string;
  status?: string;
  // Set by the bulk-ai-llms-txt sweep (or hand-edited by the merchant).
  // When non-empty, served verbatim — overrides the auto-generated body.
  llmsTxt?: string | null;
}

interface PublicCategory {
  name: string;
  nameAr?: string;
  slug: string;
}

interface PublicProduct {
  name: string;
  nameAr?: string;
  slug: string;
  price: number;
}

// ---------------------------------------------------------------------------
// Data-fetch helpers
// ---------------------------------------------------------------------------

/** Fetch all active stores (paginated, collects all pages up to 50). */
async function fetchAllStores(): Promise<PublicStore[]> {
  const stores: PublicStore[] = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const res = await fetch(`${API_URL}/public/stores?page=${page}&limit=${limit}`, {
      next: { revalidate: 3600 }, // platform list refreshes hourly
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) break;

    const json = await res.json();
    const batch: PublicStore[] = Array.isArray(json?.data) ? json.data : [];
    stores.push(...batch);

    const totalPages: number = json?.pagination?.totalPages ?? 1;
    if (page >= totalPages || page >= 50) break;
    page += 1;
  }

  return stores;
}

/** Fetch a single store by slug (includes contact info). */
async function fetchStore(slug: string): Promise<PublicStore | null> {
  try {
    const res = await fetch(`${API_URL}/public/stores/${encodeURIComponent(slug)}`, {
      next: { revalidate: 600 }, // per-store store detail refreshes every 10 min
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data?.store ?? null;
  } catch {
    return null;
  }
}

/** Fetch categories for a store (uses X-Store-ID header pattern). */
async function fetchCategories(storeId: string): Promise<PublicCategory[]> {
  try {
    const res = await fetch(`${API_URL}/public/categories`, {
      next: { revalidate: 600 },
      headers: {
        'Content-Type': 'application/json',
        'X-Store-ID': storeId,
      },
    });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.data?.categories) ? json.data.categories : [];
  } catch {
    return [];
  }
}

/**
 * Fetch up to 500 active products for a store.
 * The product service caps each page at 100, so we paginate up to 5 pages.
 */
async function fetchProducts(storeId: string): Promise<PublicProduct[]> {
  const products: PublicProduct[] = [];
  const perPage = 100;
  const maxPages = 5;

  for (let page = 1; page <= maxPages; page++) {
    try {
      const res = await fetch(
        `${API_URL}/public/products?limit=${perPage}&page=${page}&status=active`,
        {
          next: { revalidate: 600 },
          headers: {
            'Content-Type': 'application/json',
            'X-Store-ID': storeId,
          },
        }
      );
      if (!res.ok) break;
      const json = await res.json();
      const batch: PublicProduct[] = Array.isArray(json?.data?.products) ? json.data.products : [];
      products.push(...batch);

      // Stop early if we got fewer than a full page
      if (batch.length < perPage) break;
    } catch {
      break;
    }
  }

  return products;
}

// ---------------------------------------------------------------------------
// Body builders
// ---------------------------------------------------------------------------

function buildPlatformBody(stores: PublicStore[]): string {
  const storeLines = stores
    .map(s => {
      const desc = s.description?.trim() || 'Kuwait-based merchant on Force AI Store.';
      return `- [${s.name}](https://store.forcemediakw.com/${s.slug}): ${desc}`;
    })
    .join('\n');

  return `# Force AI Store — Multi-tenant Storefront Platform

> Force AI Store is the per-merchant e-commerce platform run by Force Media Kuwait.
> Each merchant gets a path-based storefront at \`store.forcemediakw.com/<slug>\`
> with their own products, branding, and contact info. Customers in Kuwait,
> Saudi Arabia, and Qatar can browse + buy across multiple merchants from one
> platform.

## Active stores

${storeLines || '_No active stores yet._'}

## Per-store structure

Every store follows the same URL pattern:

- \`/<slug>\` — store homepage (JSON-LD: Store, ItemList of featured products, BreadcrumbList)
- \`/<slug>/products\` — full catalogue (JSON-LD: ItemList, BreadcrumbList)
- \`/<slug>/categories\` — category browse
- \`/<slug>/categories/<cat>\` — products in a category (JSON-LD: ItemList, BreadcrumbList)
- \`/<slug>/products/<product-slug>\` — product detail (JSON-LD: Product with price, availability, image)
- \`/<slug>/about\` — about the merchant (JSON-LD: AboutPage, Organization)
- \`/<slug>/contact\` — contact info (JSON-LD: ContactPage, PostalAddress, ContactPoint)
- \`/<slug>/llms.txt\` — per-store LLM index with all products + categories enumerated

## For AI agents

- Schema.org structured data on every page (JSON-LD blocks in <head>)
- Sitemap: https://store.forcemediakw.com/sitemap.xml (lists every URL for every active store)
- Languages: bilingual (English + Arabic). Store default in \`Store.inLanguage\`. Customer can browse either.
- Currency: KWD (Kuwaiti Dinar) unless individual store overrides
- Real-time inventory in \`Product.offers.availability\` (InStock / OutOfStock)
- All product data is publicly accessible — no auth or scraping protection on /<slug>/* pages
- Rate limit: 100 req/min per IP for catalogue scrape

## Sitemap

https://store.forcemediakw.com/sitemap.xml
`;
}

function buildPerStoreBody(
  store: PublicStore,
  categories: PublicCategory[],
  products: PublicProduct[],
  totalProducts: number
): string {
  const base = store.domain
    ? `https://${store.domain}`
    : `https://store.forcemediakw.com/${store.slug}`;

  const catLines = categories.map(c => `- [${c.name}](${base}/categories/${c.slug})`).join('\n');

  const prodLines = products
    .map(p => {
      const price = typeof p.price === 'number' ? (p.price / 1000).toFixed(3) : '—';
      return `- [${p.name}](${base}/products/${p.slug}) — ${price} KWD`;
    })
    .join('\n');

  const contactParts: string[] = [`- Website: ${base}`];
  if (store.email) contactParts.push(`- Email: ${store.email}`);
  if (store.phone) contactParts.push(`- Phone: ${store.phone}`);
  if (store.address) contactParts.push(`- Address: ${store.address}`);
  const contactLines = contactParts.join('\n');

  const storeTitle = store.nameAr ? `${store.name} (${store.nameAr})` : store.name;
  const storeDesc = store.description || `${store.name} on Force AI Store — Kuwait-based merchant.`;

  return `# ${storeTitle}

> ${storeDesc}

## Contact

${contactLines}

## Categories (${categories.length})

${catLines || '_No active categories._'}

## Products (${totalProducts} total, showing ${products.length})

${prodLines || '_No active products._'}

## For AI agents

- Each product page has full JSON-LD \`Product\` schema with name, image, description, price, availability, currency (KWD)
- Each category page has \`ItemList\` schema enumerating products
- Sitemap for this store: ${base}/sitemap.xml (subset of the platform sitemap)
- Inventory updates in real time — re-crawl daily for fresh availability

## Platform

This store is hosted on Force AI Store, a multi-tenant e-commerce platform by
Force Media Kuwait. See https://store.forcemediakw.com/llms.txt for the
platform-wide index.
`;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET() {
  const headersList = await headers();
  const storeSlug = headersList.get('x-store-slug');

  // ── Per-store mode ────────────────────────────────────────────────────────
  if (storeSlug) {
    const store = await fetchStore(storeSlug);

    if (!store || store.status !== 'active') {
      return new Response('Not Found', { status: 404 });
    }

    // Use the store's UUID as X-Store-ID on sub-requests (categories, products).
    // The public store endpoint always includes id, so this should never fall
    // back to slug — but we guard anyway.
    const storeId: string = store.id || storeSlug;

    // Merchant-provided / AI-generated body short-circuits the auto-build.
    // Set by the bulk-ai-llms-txt sweep, or hand-edited from the admin SEO
    // page. Empty/whitespace falls through to the auto-generated body so
    // stores that haven't run the sweep still serve a useful response.
    if (store.llmsTxt && store.llmsTxt.trim()) {
      return new Response(store.llmsTxt, {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=86400',
        },
      });
    }

    const [categories, products] = await Promise.all([
      fetchCategories(storeId),
      fetchProducts(storeId),
    ]);

    // total count lives in meta.total from the products response, but we only
    // have the cap-500 slice here. Use slice length as a lower bound — good
    // enough for the index description.
    const body = buildPerStoreBody(store, categories, products, products.length);

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=86400',
      },
    });
  }

  // ── Platform mode ─────────────────────────────────────────────────────────
  const stores = await fetchAllStores();

  const body = buildPlatformBody(stores);

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
