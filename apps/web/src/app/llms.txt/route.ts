import { headers } from 'next/headers';
import { API_URL } from '../../lib/api';

/**
 * Dynamic /llms.txt — served at three levels:
 *
 *   store.force-ai.co/llms.txt
 *     → platform-level index: lists every active merchant with a one-liner
 *       + a structure map for AI crawlers. No store context in headers.
 *
 *   store.force-ai.co/<slug>/llms.txt
 *     → middleware rewrites to /llms.txt + sets x-store-slug header.
 *       Route detects the slug, fetches that store's categories + products
 *       + contact info, renders a per-store markdown index.
 *
 *   wadyaljuz.com/llms.txt (a merchant's custom domain)
 *     → middleware sets x-store-domain. Route resolves the domain to its
 *       store and renders THAT store's per-store index (links rooted at the
 *       custom domain), NOT the generic platform index.
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
  // Threaded on by fetchStore/fetchStoreByHost from the sibling
  // `data.enabledFeatures` array the /public/stores/<slug> and
  // /public/store/resolve endpoints return (same shape store-resolver.ts
  // reads client-side). Used to conditionally advertise the agent_feed and
  // agent_checkout add-ons below.
  enabledFeatures?: string[];
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
    const store = json?.data?.store ?? null;
    if (!store) return null;
    const enabledFeatures = Array.isArray(json?.data?.enabledFeatures)
      ? json.data.enabledFeatures
      : undefined;
    return { ...store, enabledFeatures };
  } catch {
    return null;
  }
}

/**
 * Resolve a custom-domain host (e.g. `wadyaljuz.com`) to its owning store via
 * the dedicated resolve endpoint. Returns null when the host isn't a known
 * custom domain (platform path, preview host, direct IP). This is what makes
 * `wadyaljuz.com/llms.txt` serve Wady Aljuz's OWN index instead of the generic
 * platform one — mirrors the host-aware resolution already used by sitemap.ts.
 */
async function fetchStoreByHost(host: string): Promise<PublicStore | null> {
  if (!host) return null;
  try {
    const res = await fetch(`${API_URL}/public/store/resolve`, {
      next: { revalidate: 600 },
      headers: { 'Content-Type': 'application/json', 'x-store-domain': host },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const store = json?.data?.store ?? null;
    if (!store) return null;
    const enabledFeatures = Array.isArray(json?.data?.enabledFeatures)
      ? json.data.enabledFeatures
      : undefined;
    return { ...store, enabledFeatures };
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
      return `- [${s.name}](https://store.force-ai.co/${s.slug}): ${desc}`;
    })
    .join('\n');

  return `# Force AI Store — Multi-tenant Storefront Platform

> Force AI Store is the per-merchant e-commerce platform by Force AI.
> Each merchant gets a path-based storefront at \`store.force-ai.co/<slug>\`
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
- Sitemap: https://store.force-ai.co/sitemap.xml (lists every URL for every active store)
- Languages: bilingual (English + Arabic). Store default in \`Store.inLanguage\`. Customer can browse either.
- Currency: KWD (Kuwaiti Dinar) unless individual store overrides
- Real-time inventory in \`Product.offers.availability\` (InStock / OutOfStock)
- All product data is publicly accessible — no auth or scraping protection on /<slug>/* pages
- Rate limit: 100 req/min per IP for catalogue scrape

## Sitemap

https://store.force-ai.co/sitemap.xml
`;
}

export function buildPerStoreBody(
  store: PublicStore,
  categories: PublicCategory[],
  products: PublicProduct[],
  totalProducts: number
): string {
  const base = store.domain ? `https://${store.domain}` : `https://store.force-ai.co/${store.slug}`;

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

  // agent_feed is in every paid plan baseline (AI-first policy, 2026-07-21),
  // so this now advertises the feed on essentially every storefront. Still
  // conditional: a super-admin StoreFeature override can disable it for a
  // specific client, and the `free` (lapsed-payment grace) plan excludes it.
  const feedSection = store.enabledFeatures?.includes('agent_feed')
    ? `\n\n## Product Feed\n\n- [Machine-readable product feed (JSON)](${base}/feeds/products.json)`
    : '';

  // agent_checkout is in every paid plan baseline (AI-first policy,
  // 2026-07-21), same rollout as agent_feed above. Advertises the MCP
  // (Model Context Protocol) endpoint an agentic shopping client can call
  // directly to search, cart, and place an order for this store — the
  // ONLY discovery surface for that endpoint (it's not linked from any
  // storefront page). Served by apps/api, not this web app, so the URL is
  // rooted at API_URL (the API's own origin), not `base`.
  // The advertisement is a CONTRACT: this is the only place an agent can learn
  // the endpoint exists, so it has to state the read/write split too. Writes
  // (add_to_cart, place_order) need the store's `x-agent-key` credential
  // (Ruling M1, 2026-09-09); reads never do. An agent that discovers 7 tools
  // here and gets an unexplained error on two of them is a broken surface.
  // `agent_checkout_open_writes` is the per-store escape hatch that turns the
  // requirement off — when it is on, say so, because then the credential line
  // would be a lie. Keep this copy in step with
  // `AGENT_CREDENTIAL_REQUIRED_MESSAGE` in apps/api/src/mcp/agent-auth.ts.
  const mcpWritesOpen = store.enabledFeatures?.includes('agent_checkout_open_writes');
  const mcpWriteLine = mcpWritesOpen
    ? `- Write tools (no credential required on this store): add_to_cart, place_order`
    : `- Write tools (credential required): add_to_cart, place_order\n- Write authentication: send the store's agent key in the \`x-agent-key\` request header. Ask the store (see Contact above) to issue one. Without it the read tools still work and the write tools return an error explaining this.`;
  const mcpSection = store.enabledFeatures?.includes('agent_checkout')
    ? `\n\n## Agentic checkout (MCP)\n\nThis store accepts orders from AI agents via the Model Context Protocol (MCP):\n\n- MCP endpoint: ${API_URL}/mcp/${store.slug}\n- Transport: Streamable HTTP (stateless, POST only)\n- Read tools (no credential): search_products, get_product, get_store_info, view_cart, get_order_status\n${mcpWriteLine}`
    : '';

  return `# ${storeTitle}

> ${storeDesc}

## Contact

${contactLines}

## Categories (${categories.length})

${catLines || '_No active categories._'}

## Products (${totalProducts} total, showing ${products.length})

${prodLines || '_No active products._'}${feedSection}${mcpSection}

## For AI agents

- Each product page has full JSON-LD \`Product\` schema with name, image, description, price, availability, currency (KWD)
- Each category page has \`ItemList\` schema enumerating products
- Sitemap for this store: ${base}/sitemap.xml (subset of the platform sitemap)
- Inventory updates in real time — re-crawl daily for fresh availability

## Platform

This store is hosted on Force AI Store, a multi-tenant e-commerce platform by
Force AI. See https://store.force-ai.co/llms.txt for the
platform-wide index.
`;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Build the per-store llms.txt Response: a merchant-provided body short-circuits
 * the auto-build; otherwise enumerate categories + products. Shared by the
 * platform-path (slug) and custom-domain branches so both render identically.
 */
async function perStoreResponse(store: PublicStore): Promise<Response> {
  // The public store endpoint always includes id, so this should never fall
  // back to slug — but we guard anyway.
  const storeId: string = store.id || store.slug;

  // Merchant-provided / AI-generated body short-circuits the auto-build. Set by
  // the bulk-ai-llms-txt sweep, or hand-edited from the admin SEO page.
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
  const body = buildPerStoreBody(store, categories, products, products.length);

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=86400',
    },
  });
}

export async function GET() {
  const headersList = await headers();
  const storeSlug = headersList.get('x-store-slug');
  const storeDomain = headersList.get('x-store-domain');

  // ── Per-store mode (platform path: store.force-ai.co/<slug>/llms.txt) ───────
  if (storeSlug) {
    const store = await fetchStore(storeSlug);
    if (!store || store.status !== 'active') {
      return new Response('Not Found', { status: 404 });
    }
    return perStoreResponse(store);
  }

  // ── Per-store mode (custom domain: wadyaljuz.com/llms.txt) ──────────────────
  // The middleware sets x-store-domain (NOT x-store-slug) on custom domains, so
  // without this branch a merchant's own domain fell through to the generic
  // platform index. Resolve the domain → load the full store via the slug path
  // (so contact + llmsTxt override behave identically) → serve THAT store's
  // index. Unknown/inactive domains fall through to the platform index, not 404.
  if (storeDomain) {
    const resolved = await fetchStoreByHost(storeDomain);
    const store = resolved?.slug ? ((await fetchStore(resolved.slug)) ?? resolved) : resolved;
    if (store && (!store.status || store.status === 'active')) {
      return perStoreResponse(store);
    }
  }

  // ── Platform mode (store.force-ai.co/llms.txt + the Force AI landing) ───────
  // The generic multi-tenant index — only the platform host reaches here.
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
