import { localePathsOn, localizeUrlsInText, storeKeyForHost } from '../../lib/locale-paths';
import { headers } from 'next/headers';
import { API_URL } from '../../lib/api';
import { hidesFromSearch } from '../../lib/hide-from-search';
import { resolvedViaCookie } from '../../lib/agent-store-resolver';
import { storeOrigin, BRAND, resolveDefaultLanguage } from '@ebda/shared';

import { minorToDecimalString, REGION } from '@ebda/shared';
/**
 * Dynamic /llms.txt — served at three levels:
 *
 *   ebda.app/llms.txt
 *     → platform-level index: lists every active merchant with a one-liner
 *       + a structure map for AI crawlers. No store context in headers.
 *
 *   <slug>.ebda.app/llms.txt
 *     → middleware sets x-store-domain to the host. Route resolves the host to
 *       its store, fetches that store's categories + products + contact info,
 *       renders a per-store markdown index.
 *
 *   demo-shop.example/llms.txt (a merchant's custom domain)
 *     → middleware sets x-store-domain. Route resolves the domain to its
 *       store and renders THAT store's per-store index (links rooted at the
 *       custom domain), NOT the generic platform index. A store host that
 *       resolves to NO store is a 404, never the platform index.
 *
 * All data is fetched from the public API (no direct Prisma — the web app
 * doesn't depend on @ebda/database).
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
  /** `settings.defaultLanguage` is the language the prefixed URLs use on a locale-path store (LOCALE-PATHS-1). */
  settings?: Record<string, unknown> | null;
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
  /** 'gold_rate' when the price follows the store's gold rate (Phase B5). */
  pricingMode?: string;
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
      // Per-store detail refreshes every 10 min, AND carries the same
      // `store-slug:<slug>` tag the store resolver uses, so the API's
      // bustStoreCaches purge (bulk AEO/GEO/SEO sweeps, settings saves)
      // reaches llms.txt too instead of waiting out the 600s (issue 2199).
      next: { revalidate: 600, tags: [`store-slug:${slug}`] },
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
 * Resolve a custom-domain host (e.g. `demo-shop.example`) to its owning store via
 * the dedicated resolve endpoint. Returns null when the host isn't a known
 * custom domain (platform path, preview host, direct IP). This is what makes
 * `demo-shop.example/llms.txt` serve Demo Shop's OWN index instead of the generic
 * platform one — mirrors the host-aware resolution already used by sitemap.ts.
 */
async function fetchStoreByHost(host: string): Promise<PublicStore | null> {
  if (!host) return null;
  try {
    const res = await fetch(`${API_URL}/public/store/resolve`, {
      next: { revalidate: 600, tags: [`store-domain:${host}`] },
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

/**
 * Fetch categories for a store (uses X-Store-ID header pattern).
 *
 * Returns `null` when the API could not be asked (non-2xx, network error,
 * unparseable body) and `[]` only when the store genuinely has no categories.
 * The two MUST stay distinct (#1853): `fixCategoryLinks` treats an empty set
 * as "every /categories/ link is dead" and deletes those lines, so collapsing
 * a transient 429/5xx into `[]` gutted a merchant's own llms.txt and the CDN
 * then held the damaged copy for up to a day.
 */
async function fetchCategories(storeId: string): Promise<PublicCategory[] | null> {
  try {
    const res = await fetch(`${API_URL}/public/categories`, {
      next: { revalidate: 600 },
      headers: {
        'Content-Type': 'application/json',
        'X-Store-ID': storeId,
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return Array.isArray(json?.data?.categories) ? json.data.categories : null;
  } catch {
    return null;
  }
}

/**
 * Fetch up to 500 active products for a store.
 * The product service caps each page at 100, so we paginate up to 5 pages.
 *
 * Same contract as `fetchCategories` (#2224): `null` = the API could not be
 * asked (any page non-2xx, network error, unparseable body) — distinct from
 * `[]`, a store that genuinely has no active products. A partial list is
 * `null` too: the body states a total, and "showing 100 of 100" after page 2
 * failed is as false as "0 products".
 */
async function fetchProducts(storeId: string): Promise<PublicProduct[] | null> {
  const products: PublicProduct[] = [];
  const perPage = 100;
  const maxPages = 5;

  for (let page = 1; page <= maxPages; page++) {
    try {
      const res = await fetch(
        `${API_URL}/public/products?limit=${perPage}&page=${page}&status=active`,
        {
          // Tagged like the product feed so a gold-rate write (which revalidates `products:<store>`) drops this
          // copy at once instead of leaving yesterday's rate in the data cache for 10 minutes (Ruling B5-21).
          next: { revalidate: 600, tags: [`products:${storeId}`] },
          headers: {
            'Content-Type': 'application/json',
            'X-Store-ID': storeId,
          },
        }
      );
      if (!res.ok) return null;
      const json = await res.json();
      if (!Array.isArray(json?.data?.products)) return null;
      const batch: PublicProduct[] = json.data.products;
      products.push(...batch);

      // Stop early if we got fewer than a full page
      if (batch.length < perPage) break;
    } catch {
      return null;
    }
  }

  return products;
}

// ---------------------------------------------------------------------------
// Body builders
// ---------------------------------------------------------------------------

export function buildPlatformBody(stores: PublicStore[]): string {
  const storeLines = stores
    .map(s => {
      const desc = s.description?.trim() || 'Egypt-based merchant on Ebda Store.';
      return `- [${s.name}](${storeOrigin(s.slug)}): ${desc}`;
    })
    .join('\n');

  return `# ${BRAND.product.nameEn} — Multi-tenant Storefront Platform

> ${BRAND.product.nameEn} is the per-merchant e-commerce platform by ${BRAND.company.shortNameEn}.
> Each merchant gets a storefront at \`<slug>${BRAND.domains.storeSuffix}\`
> with their own products, branding, and contact info. Customers in Egypt can browse + buy across multiple merchants from one
> platform.

## Active stores

${storeLines || '_No active stores yet._'}

## Per-store structure

Every store lives on its own host (\`https://<slug>${BRAND.domains.storeSuffix}\`, or the merchant's custom domain) and follows the same URL pattern:

- \`/\` — store homepage (JSON-LD: Store, ItemList of featured products, BreadcrumbList)
- \`/products\` — full catalogue (JSON-LD: ItemList, BreadcrumbList)
- \`/categories\` — category browse
- \`/products?category=<cat>\` — products in a category (JSON-LD: ItemList, BreadcrumbList)
- \`/products/<product-slug>\` — product detail (JSON-LD: Product with price, availability, image)
- \`/about\` — about the merchant (JSON-LD: AboutPage, Organization)
- \`/contact\` — contact info (JSON-LD: ContactPage, PostalAddress, ContactPoint)
- \`/llms.txt\` — per-store LLM index with all products + categories enumerated

## For AI agents

- Schema.org structured data on every page (JSON-LD blocks in <head>)
- Sitemap: each store serves its own \`/sitemap.xml\` on its own host
- Languages: bilingual (English + Arabic). Store default in \`Store.inLanguage\`. Customer can browse either.
- Currency: ${REGION.currency} (Egyptian Pound, 2 decimals) unless individual store overrides
- Real-time inventory in \`Product.offers.availability\` (InStock / OutOfStock)
- All product data is publicly accessible — no auth or scraping protection on any store page
- Rate limit: 100 req/min per IP for catalogue scrape

## Sitemap

Each store serves its own sitemap at \`/sitemap.xml\` on its host.
`;
}

export function buildPerStoreBody(
  store: PublicStore,
  categories: PublicCategory[],
  products: PublicProduct[],
  totalProducts: number
): string {
  const base = storeBaseUrl(store);

  // `/products?category=<slug>` is the storefront's ACTUAL category-browse
  // URL (see `ProductsPageBody.tsx`'s `?category=` query param) — there is
  // no `/categories/[slug]` route anywhere in this app. Building the link
  // that way here was the same dead-link pattern A4-2 found in the
  // merchant-override text; see `fixCategoryLinks` below for the second
  // half of that fix (rewriting/dropping dead links in the AI-generated
  // override text this function's output can be replaced by).
  const catLines = categoryLines(categories, base);
  const prodLines = productLines(products, base);
  const contactLines = storeContactLines(store, base);

  const storeTitle = store.nameAr ? `${store.name} (${store.nameAr})` : store.name;
  const storeDesc = store.description || `${store.name} on Ebda Store — Egypt-based merchant.`;

  return `# ${storeTitle}

> ${storeDesc}

## Contact

${contactLines}

## Categories (${categories.length})

${catLines || '_No active categories._'}

## Products (${totalProducts} total, showing ${products.length})

${prodLines || '_No active products._'}${buildAgentSections(store, base)}

## For AI agents

- Each product page has full JSON-LD \`Product\` schema with name, image, description, price, availability, currency (${REGION.currency})
- Each category page has \`ItemList\` schema enumerating products
- Sitemap for this store: ${base}/sitemap.xml (subset of the platform sitemap)
- Inventory updates in real time — re-crawl daily for fresh availability

## Platform

This store is hosted on Ebda Store, a multi-tenant e-commerce platform by
Ebda AI Studio. See https://ebda.app/llms.txt for the
platform-wide index.
`;
}

/** `- [name](url)` per category (issue 1810: extracted from buildPerStoreBody unchanged). */
function categoryLines(categories: PublicCategory[], base: string): string {
  return categories
    .map(c => `- [${c.name}](${base}/products?category=${encodeURIComponent(c.slug)})`)
    .join('\n');
}

/** `- [name](url) — price EGP` per product; an unknown price renders as `—`, never 0. */
function productLines(products: PublicProduct[], base: string): string {
  return products
    .map(p => {
      const price = typeof p.price === 'number' ? minorToDecimalString(p.price) : '—';
      return `- [${p.name}](${base}/products/${p.slug}) — ${price} ${REGION.currency}`;
    })
    .join('\n');
}

/** Website always; email/phone/address only when the store has them. */
function storeContactLines(store: PublicStore, base: string): string {
  const contactParts: string[] = [`- Website: ${base}`];
  if (store.email) contactParts.push(`- Email: ${store.email}`);
  if (store.phone) contactParts.push(`- Phone: ${store.phone}`);
  if (store.address) contactParts.push(`- Address: ${store.address}`);
  return contactParts.join('\n');
}

/** Public origin the store's links are rooted at (custom domain or platform path). */
function storeBaseUrl(store: PublicStore): string {
  return store.domain ? `https://${store.domain}` : storeOrigin(store.slug);
}

/**
 * The generated discovery sections (product feed + agentic-checkout MCP
 * contract). Shared by the auto-built body AND appended to a stored
 * `store.llmsTxt` override (#1667): the override is AI-written by the GEO
 * sweep and knows nothing about MCP or `x-agent-key`, and this file is the
 * only place an agent can learn either — so the contract must render on
 * every per-store body, not only the auto-built one.
 */
function buildAgentSections(store: PublicStore, base: string): string {
  return `${buildFeedSection(store, base)}${buildMcpSection(store, base)}`;
}

/** Heading of the generated product-feed section — also its dedupe sentinel. */
export const FEED_SECTION_HEADING = '## Product Feed';
/** Heading of the generated MCP section — also its dedupe sentinel. */
export const MCP_SECTION_HEADING = '## Agentic checkout (MCP)';

function buildFeedSection(store: PublicStore, base: string): string {
  // agent_feed is in every paid plan baseline (AI-first policy, 2026-07-21),
  // so this now advertises the feed on essentially every storefront. Still
  // conditional: a super-admin StoreFeature override can disable it for a
  // specific client, and the `free` (lapsed-payment grace) plan excludes it.
  return store.enabledFeatures?.includes('agent_feed')
    ? `\n\n${FEED_SECTION_HEADING}\n\n- [Machine-readable product feed (JSON)](${base}/feeds/products.json)`
    : '';
}

function buildMcpSection(store: PublicStore, base: string): string {
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
  // requirement off. Do NOT disclose "no credential required" when it's on —
  // this document is public and unauthenticated, so that line would announce
  // to anyone (not just the intended agent) which stores have the emergency
  // open-write hatch enabled (audit-followup #1663). State only that write
  // tools exist; an agent that tries without a credential either succeeds
  // (open) or gets the same explanatory error as any other store. Keep this
  // copy in step with `AGENT_CREDENTIAL_REQUIRED_MESSAGE` in
  // apps/api/src/mcp/agent-auth.ts.
  //
  // Non-disclosure note: the two well-known JSON documents below go further
  // and ALWAYS advertise the machine-readable `write: 'api_key'` shape, even
  // when this hatch is on — they never flip to a "no credential" value the
  // way this prose line drops the credential mention entirely. Both surfaces
  // implement the same rule (never CONFIRM the hatch is on to a public,
  // unauthenticated reader); do not "fix" acp.json/ucp to branch on the hatch
  // to match this file's wording — that would reintroduce the disclosure
  // (scoped-audit P2 on PR #1942).
  const mcpWritesOpen = store.enabledFeatures?.includes('agent_checkout_open_writes');
  const mcpWriteLine = mcpWritesOpen
    ? `- Write tools: add_to_cart, place_order`
    : `- Write tools (credential required): add_to_cart, place_order\n- Write authentication: send the store's agent key in the \`x-agent-key\` request header. Ask the store (see Contact above) to issue one. Without it the read tools still work and the write tools return an error explaining this.`;
  // The two well-known discovery documents (added 2026-09-11) carry the SAME
  // endpoint and the same credential contract in ACP (OpenAI/Stripe/Meta) and
  // UCP (Google/Shopify) shape. Listed here because an agent that finds this
  // file should not have to guess that they exist — and one that starts from a
  // well-known path is pointed back here by both of them.
  //
  // Gated on the same `agent_checkout` flag those routes gate on, so the three
  // surfaces appear and disappear together. If you change the credential line
  // above, change it in apps/web/src/app/.well-known/{acp.json,ucp}/route.ts
  // too — tests/unit/well-known-agent-discovery.test.ts asserts they agree.
  const discoveryLines = `\n- Discovery (ACP): ${base}/.well-known/acp.json\n- Discovery (UCP): ${base}/.well-known/ucp`;
  return store.enabledFeatures?.includes('agent_checkout')
    ? `\n\n${MCP_SECTION_HEADING}\n\nThis store accepts orders from AI agents via the Model Context Protocol (MCP):\n\n- MCP endpoint: ${API_URL}/mcp/${store.slug}\n- Transport: Streamable HTTP (stateless, POST only)\n- Read tools (no credential): search_products, get_product, get_store_info, view_cart, get_order_status\n${mcpWriteLine}${discoveryLines}`
    : '';
}

// ---------------------------------------------------------------------------
// Dead-link defense (A4-2)
// ---------------------------------------------------------------------------

/**
 * Rewrite or drop every `/categories/<slug>` link in a served llms.txt body.
 *
 * There is no `/categories/[slug]` route anywhere in this Next.js app —
 * category browsing lives at `/products?category=<slug>` (see
 * `ProductsPageBody.tsx`). Verified live 2026-09-22: 18/18 `/categories/*`
 * links across demo-store.example's and demo-shop.example's served llms.txt 404'd,
 * both AI-generated by the `bulk-ai-llms-txt` sweep (free-text Gemini
 * output — see `apps/api/src/lib/inngest/functions/bulk-ai-geo.ts`) and
 * stored verbatim as the merchant override (`store.llmsTxt`), which
 * `perStoreResponse` used to serve untouched.
 *
 * A slug matching a real, currently-active category is rewritten to the
 * URL that actually works. A slug matching nothing (hallucinated, renamed,
 * or since-deleted) has its WHOLE LINE dropped — usually one markdown list
 * item — rather than served as a link that will never resolve. Runs on
 * every served body (both the merchant-override and the auto-built path),
 * so it defends the override text even though `buildPerStoreBody` above
 * already emits the correct URL shape.
 */
export function fixCategoryLinks(body: string, categories: Array<{ slug: string }>): string {
  const validSlugs = new Set(categories.map(c => c.slug));
  // The platform's real slug charset (#1854): ASCII + the Arabic block, as
  // SLUG_STRIP in @ebda/shared mints them, raw OR percent-encoded. An
  // ASCII-only class missed a fully-Arabic slug entirely (dead link served)
  // and captured only the ASCII prefix of a mixed one (valid line dropped).
  const categoryLinkPattern = /\/categories\/((?:[a-z0-9\u0600-\u06FF-]|%[0-9a-f]{2})+)/gi;
  const decodeSlug = (raw: string): string => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw; // malformed escape — compare as-is (will not match a real slug)
    }
  };

  return body
    .split('\n')
    .map(line => {
      const matches = [...line.matchAll(categoryLinkPattern)];
      if (matches.length === 0) return line;
      if (!matches.every(m => validSlugs.has(decodeSlug(m[1])))) return null;
      return line.replace(
        categoryLinkPattern,
        (_match, slug: string) => `/products?category=${encodeURIComponent(decodeSlug(slug))}`
      );
    })
    .filter((line): line is string => line !== null)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Build the per-store llms.txt Response: a merchant-provided body short-circuits
 * the product/category auto-build (but still passes through `fixCategoryLinks`);
 * otherwise enumerate categories + products. Shared by the platform-path
 * (slug) and custom-domain branches so both render identically.
 */
// Exported for fix-category-links.test.ts, which calls this directly rather
// than through GET(). `viaCookie` defaults to false (URL/Host-resolved, the
// shared-cacheable path) for those single-arg call sites; GET() below always
// passes it explicitly.
export async function perStoreResponse(
  store: PublicStore,
  viaCookie = false,
  /** The request host (`x-store-domain`): the language-in-URL allowlist is keyed by it. */
  requestHost?: string
): Promise<Response> {
  // The public store endpoint always includes id, so this should never fall
  // back to slug — but we guard anyway.
  const storeId: string = store.id || store.slug;

  // The merchant hid the store from search engines: no index of its catalogue for AI crawlers either.
  if (hidesFromSearch(store as { settings?: Record<string, unknown> | null })) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
    });
  }

  // Categories are needed either way now: to validate/rewrite the merchant
  // override's links, or to build the auto-generated body. `null` = the API
  // could not be asked (#1853) — distinct from a store with no categories.
  const categories = await fetchCategories(storeId);

  // Merchant-provided / AI-generated body short-circuits the product/category
  // auto-build. Set by the bulk-ai-llms-txt sweep, or hand-edited from the
  // admin SEO page. The generated feed + MCP discovery sections are still
  // appended (#1667) unless the stored text already carries the MCP heading.
  //
  // Each generated section is appended independently, keyed on its OWN
  // heading (#2131): an override that already documents the feed must not get
  // a second `## Product Feed`, and one that already carries the MCP section
  // must still receive the feed section when `agent_feed` is on.
  let body: string;
  const degraded = categories === null;
  // A store that sells gold-rate products lists prices that follow a rate a CDN purge cannot reach: its edge
  // window is the same at-most-60-second, no-stale-tail BOUNDED-stale class as its product feed (B5-21).
  let hasGold = false;
  if (store.llmsTxt && store.llmsTxt.trim()) {
    body = store.llmsTxt;
    const base = storeBaseUrl(store);
    const missing = [
      body.includes(FEED_SECTION_HEADING) ? '' : buildFeedSection(store, base),
      body.includes(MCP_SECTION_HEADING) ? '' : buildMcpSection(store, base),
    ].join('');
    if (missing) body = `${body.trimEnd()}${missing}\n`;
  } else {
    // The auto-built body ENUMERATES categories and products, so publishing
    // it after either fetch failed would assert to every crawler that the
    // store has none (#2224, the auto-build twin of #1853). Answer 503 with a
    // short Retry-After instead: the crawler and the CDN retry, and nothing
    // false is cached. (The override branch above has no enumerations of its
    // own and is served with the short TTL below.)
    const products = await fetchProducts(storeId);
    if (categories === null || products === null) {
      return new Response('llms.txt is temporarily unavailable — retry shortly.\n', {
        status: 503,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Retry-After': '60',
          'Cache-Control': 'no-store',
        },
      });
    }
    body = buildPerStoreBody(store, categories, products, products.length);
    hasGold = products.some(p => p.pricingMode === 'gold_rate');
  }

  // Only sanitize against a category set we actually fetched: an empty set
  // makes fixCategoryLinks drop every /categories/ line, so running it after
  // a failed fetch deletes valid content. Serve the body as-is instead, on a
  // short edge TTL so the next request retries (#1853).
  if (categories !== null) body = fixCategoryLinks(body, categories);

  // A store with language-in-the-URL ON (LOCALE-PATHS-1): the links this index publishes are the CANONICAL ones (the store's
  // default-language prefix), so an agent never lands on an old URL that redirects. Off: unchanged.
  const hostKey = storeKeyForHost(requestHost ?? store.domain ?? store.slug);
  if (localePathsOn(hostKey)) {
    body = localizeUrlsInText(
      body,
      [storeBaseUrl(store), ...(requestHost ? [`https://${requestHost}`] : [])],
      resolveDefaultLanguage(store.settings?.defaultLanguage as string | undefined)
    );
  }

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      // Shared-cacheable because `/llms.txt` is resolved ONLY from the request
      // Host (`<slug>.ebda.app` or the custom domain): middleware sets
      // `x-store-domain` from it and no cookie or path ever names a store, so
      // the URL (host included) fully keys the answer. `viaCookie → private` is
      // a retired second line of defence (see resolvedViaCookie). A degraded body (an upstream API could not be
      // asked, #1853/#2224) gets a short retry TTL so the next request heals it.
      'Cache-Control': viaCookie
        ? 'private, max-age=600'
        : degraded || hasGold
          ? 'public, s-maxage=60'
          : 'public, s-maxage=600, stale-while-revalidate=86400',
      ...(viaCookie ? {} : { Vary: 'Cookie' }),
    },
  });
}

export async function GET() {
  const headersList = await headers();
  const storeDomain = headersList.get('x-store-domain');
  const viaCookie = await resolvedViaCookie();

  // ── Per-store mode (`<slug>.ebda.app` or a custom domain) ──────────────────
  // The middleware sets x-store-domain to the request HOST for every store
  // host. Resolve it → load the full store via the slug path (so contact +
  // llmsTxt override behave identically) → serve THAT store's index. A store
  // host that resolves to no (active) store is a 404: it must NEVER fall
  // through to the platform index or answer as some other store.
  if (storeDomain) {
    const resolved = await fetchStoreByHost(storeDomain);
    const store = resolved?.slug ? ((await fetchStore(resolved.slug)) ?? resolved) : resolved;
    if (!store || (store.status && store.status !== 'active')) {
      return new Response('Not Found', { status: 404 });
    }
    // Host-based resolution, never cookie-based.
    return perStoreResponse(store, viaCookie, storeDomain);
  }

  // ── Platform mode (ebda.app/llms.txt + the Ebda landing) ───────
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
