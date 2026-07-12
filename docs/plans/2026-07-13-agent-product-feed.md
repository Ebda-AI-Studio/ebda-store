# AI Product Feed (agent_feed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-tenant public JSON product feed (`/feeds/products.json`) that AI assistants and shopping agents can read, sold as an individually-priced add-on feature (`agent_feed`).

**Architecture:** New feature key `agent_feed` (tier `addon`, in NO plan baseline — enabled per tenant via `StoreFeature` override, exactly how an individually-sold feature works). The feed is built once in the API (`GET /api/v1/public/feed/products.json`, feature-gated fail-closed, Redis + edge cached) and exposed on every storefront domain by a thin `apps/web` Route Handler modeled on `apps/web/src/app/llms.txt/route.ts`. Feed JSON follows the OpenAI Product Feed Spec field naming (title/description/link/image_link/price/availability).

**Tech Stack:** Express (apps/api), Next.js App Router route handler on Cloudflare Workers (apps/web), Prisma via existing `ProductService.listPublic`, Vitest.

## Global Constraints

- Prices are stored as **fils** (`Int`); feed prices render as `(price/1000).toFixed(3) + ' ' + store.currency` (e.g. `"12.500 KWD"`).
- `agent_feed` goes in `FEATURE_KEYS_ARRAY` + `FEATURE_REGISTRY` but **NOT** in any array in `plan-baselines.ts` (not STARTER_CORE, not additions). Default resolution = disabled everywhere; sale = super-admin enables a `StoreFeature` row via the existing FeatureMatrix admin grid.
- Fail-closed gating: disabled feature → HTTP **404** (not 403 — a public URL must not advertise the feature's existence).
- `apps/web` never imports Prisma/`@force/database`; all data via the public API (same rule as llms.txt, see its doc comment).
- No changes to pricing numbers, SLA terms, or contract legal clauses in docs.
- Commit style: conventional commits, `git add` specific paths only (never `-A`/`.`), every commit ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01ALD5zwmFH7ot7tTQAxorac`
- Worktree: `/Users/ahmadsharaf/Desktop/projects/_worktrees/force-website-builder__feat-agent-product-feed` (branch `feat/agent-product-feed`). Never touch the root checkout.
- Verify commands: `npm run typecheck`, `npm run test:unit` (root; Vitest, `maxWorkers: 1`).

---

### Task 1: Register the `agent_feed` feature key

**Files:**

- Modify: `packages/shared/src/features.ts` (FEATURE_KEYS_ARRAY ~line 10-53; FEATURE_REGISTRY ~line 106-492)
- Modify: `tests/unit/feature.test.ts` (asserts `FEATURE_KEYS_ARRAY` length 37)
- Test: `packages/shared/src/__tests__/plan-baselines.test.ts` (must keep passing unchanged)

**Interfaces:**

- Produces: `FeatureKey` union now includes `'agent_feed'`; `FEATURE_REGISTRY.agent_feed: FeatureDefinition`.

- [ ] **Step 1: Update the length assertion first (failing test)**

In `tests/unit/feature.test.ts`, change the `toHaveLength(37)` assertion to `toHaveLength(38)`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/feature.test.ts`
Expected: FAIL — expected length 38, received 37.

- [ ] **Step 3: Add the key + registry entry**

In `packages/shared/src/features.ts`, add `'agent_feed'` to `FEATURE_KEYS_ARRAY` (alphabetical/near marketing keys — match the file's existing ordering convention), and add to `FEATURE_REGISTRY` (placed near the other `category: 'marketing'` entries):

```ts
agent_feed: {
  key: 'agent_feed',
  name: 'AI Product Feed',
  nameAr: 'خلاصة المنتجات للذكاء الاصطناعي',
  description:
    'Publishes a machine-readable product feed at /feeds/products.json so AI assistants and shopping agents (ChatGPT, Perplexity, and agent crawlers) can read, cite, and recommend the store’s products. Follows the OpenAI Product Feed field conventions.',
  descriptionAr:
    'ينشر خلاصة منتجات قابلة للقراءة آليًا على /feeds/products.json حتى تتمكن مساعدات الذكاء الاصطناعي ووكلاء التسوق (ChatGPT وPerplexity وزواحف الوكلاء) من قراءة منتجات المتجر والاستشهاد بها والتوصية بها. تتبع اصطلاحات حقول خلاصة منتجات OpenAI.',
  category: 'marketing',
  tier: 'addon',
},
```

Do NOT touch `plan-baselines.ts`.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/unit/feature.test.ts packages/shared/src/__tests__/plan-baselines.test.ts`
Expected: PASS (baseline superset test unaffected because the key is in no baseline).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/features.ts tests/unit/feature.test.ts
git commit -m "feat(shared): register agent_feed add-on feature key"
```

### Task 2: Feed builder (pure function) in apps/api

**Files:**

- Create: `apps/api/src/lib/product-feed.ts`
- Test: `tests/unit/product-feed.test.ts`

**Interfaces:**

- Consumes: enriched public products from `ProductService.listPublic` (fields: `id, name, nameAr, slug, description, descriptionAr, price, compareAtPrice, discountType, discountValue, inStock, acceptsBackorder, updatedAt, images[{url, alt, position}], categories[{category:{name, slug}}]`).
- Produces: `buildProductFeed(store: FeedStore, products: FeedProductInput[], baseUrl: string): ProductFeedJson` — used verbatim by Task 3.

- [ ] **Step 1: Write the failing test** (`tests/unit/product-feed.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { buildProductFeed } from '@api/lib/product-feed';

const store = { id: 's1', name: 'Wady Aljuz', slug: 'wady-aljuz', currency: 'KWD' };
const product = {
  id: 'p1',
  name: 'Olive Oil 1L',
  nameAr: 'زيت زيتون ١ لتر',
  slug: 'olive-oil-1l',
  description: 'Cold pressed.',
  descriptionAr: 'عصرة أولى.',
  price: 12500,
  compareAtPrice: 15000,
  inStock: true,
  acceptsBackorder: false,
  updatedAt: new Date('2026-07-01T00:00:00Z'),
  images: [{ url: 'https://cdn.example/img1.jpg', alt: null, position: 0 }],
  categories: [{ category: { name: 'Pantry', slug: 'pantry' } }],
};

describe('buildProductFeed', () => {
  it('maps a product to OpenAI-convention feed fields', () => {
    const feed = buildProductFeed(store, [product], 'https://wadyaljuz.com');
    expect(feed.store).toEqual({
      name: 'Wady Aljuz',
      url: 'https://wadyaljuz.com',
      currency: 'KWD',
    });
    const item = feed.products[0];
    expect(item.item_id).toBe('p1');
    expect(item.title).toBe('Olive Oil 1L');
    expect(item.title_ar).toBe('زيت زيتون ١ لتر');
    expect(item.link).toBe('https://wadyaljuz.com/products/olive-oil-1l');
    expect(item.image_link).toBe('https://cdn.example/img1.jpg');
    expect(item.price).toBe('15.000 KWD'); // compareAtPrice is the base price
    expect(item.sale_price).toBe('12.500 KWD'); // price is what the customer pays
    expect(item.availability).toBe('in_stock');
    expect(item.categories).toEqual(['Pantry']);
    expect(item.updated_at).toBe('2026-07-01T00:00:00.000Z');
  });

  it('handles out of stock, backorder, and no compare-at', () => {
    const p = { ...product, compareAtPrice: null, inStock: false, acceptsBackorder: true };
    const item = buildProductFeed(store, [p], 'https://x.com').products[0];
    expect(item.price).toBe('12.500 KWD');
    expect(item.sale_price).toBeUndefined();
    expect(item.availability).toBe('backorder');
    const p2 = { ...p, acceptsBackorder: false };
    expect(buildProductFeed(store, [p2], 'https://x.com').products[0].availability).toBe(
      'out_of_stock'
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/unit/product-feed.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** (`apps/api/src/lib/product-feed.ts`)

```ts
/**
 * Pure builder for the public AI product feed (agent_feed feature).
 * Field naming follows the OpenAI Product Feed conventions:
 * item_id / title / description / link / image_link / price / sale_price / availability.
 * Prices are stored in fils; rendered as "12.500 KWD".
 */
export interface FeedStore {
  id: string;
  name: string;
  slug: string;
  currency: string;
}
export interface FeedProductInput {
  id: string;
  name: string;
  nameAr?: string | null;
  slug: string;
  description?: string | null;
  descriptionAr?: string | null;
  price: number;
  compareAtPrice?: number | null;
  inStock: boolean;
  acceptsBackorder: boolean;
  updatedAt: Date | string;
  images: Array<{ url: string; alt?: string | null; position: number }>;
  categories: Array<{ category: { name: string; slug: string } }>;
}
export interface ProductFeedItem {
  item_id: string;
  title: string;
  title_ar?: string;
  description?: string;
  description_ar?: string;
  link: string;
  image_link?: string;
  additional_image_links?: string[];
  price: string;
  sale_price?: string;
  availability: 'in_stock' | 'out_of_stock' | 'backorder';
  categories: string[];
  updated_at: string;
}
export interface ProductFeedJson {
  version: '1.0';
  generated_at: string;
  store: { name: string; url: string; currency: string };
  product_count: number;
  products: ProductFeedItem[];
}

const money = (fils: number, currency: string) => `${(fils / 1000).toFixed(3)} ${currency}`;

export function buildProductFeed(
  store: FeedStore,
  products: FeedProductInput[],
  baseUrl: string
): ProductFeedJson {
  const items = products.map((p): ProductFeedItem => {
    const onSale = p.compareAtPrice != null && p.compareAtPrice > p.price;
    const images = [...p.images].sort((a, b) => a.position - b.position);
    return {
      item_id: p.id,
      title: p.name,
      ...(p.nameAr ? { title_ar: p.nameAr } : {}),
      ...(p.description ? { description: p.description } : {}),
      ...(p.descriptionAr ? { description_ar: p.descriptionAr } : {}),
      link: `${baseUrl}/products/${p.slug}`,
      ...(images[0] ? { image_link: images[0].url } : {}),
      ...(images.length > 1 ? { additional_image_links: images.slice(1).map(i => i.url) } : {}),
      price: money(onSale ? p.compareAtPrice! : p.price, store.currency),
      ...(onSale ? { sale_price: money(p.price, store.currency) } : {}),
      availability: p.inStock ? 'in_stock' : p.acceptsBackorder ? 'backorder' : 'out_of_stock',
      categories: p.categories.map(c => c.category.name),
      updated_at: new Date(p.updatedAt).toISOString(),
    };
  });
  return {
    version: '1.0',
    generated_at: new Date().toISOString(),
    store: { name: store.name, url: baseUrl, currency: store.currency },
    product_count: items.length,
    products: items,
  };
}
```

- [ ] **Step 4: Run tests** — `npx vitest run tests/unit/product-feed.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/product-feed.ts tests/unit/product-feed.test.ts
git commit -m "feat(api): pure product-feed builder (OpenAI feed conventions)"
```

### Task 3: Public API route `GET /public/feed/products.json`

**Files:**

- Modify: `apps/api/src/routes/public.routes.ts` (add route near `GET /products`, ~line 141-231 pattern)
- Test: `tests/integration/agent-feed.test.ts`

**Interfaces:**

- Consumes: `getStoreIdFromRequest(req)` (`apps/api/src/utils/store-helpers.ts`), `featureService.isFeatureEnabled(storeId, 'agent_feed')`, `ProductService.listPublic(storeId, {...})`, `buildProductFeed` (Task 2), `getCached` (`apps/api/src/lib/public-cache.ts`), `setEdgeCache` (`apps/api/src/lib/edge-cache.ts`).
- Produces: `GET /api/v1/public/feed/products.json` → 200 `ProductFeedJson` when enabled; 404 `{ error: { code: 'NOT_FOUND' } }`-shaped standard error when disabled. Consumed by Task 4.

- [ ] **Step 1: Write the failing integration test** (`tests/integration/agent-feed.test.ts` — follow the setup pattern of `tests/integration/feature-flag-enforcement.test.ts`: real Postgres/Redis, seed a store + one active product; copy its store/product factory helpers)

Test cases (write them fully in the file, mirroring the sibling test's helpers):

1. Feed disabled (no `StoreFeature` row, key in no baseline) → `GET /api/v1/public/feed/products.json` with `X-Store-ID: <storeId>` returns **404**.
2. Enable via `StoreFeature` upsert (`{ storeId, featureKey: 'agent_feed', enabled: true }`) → same request returns **200**, body has `products` array with the seeded product: `title`, `link` ending `/products/<slug>`, `price` matching `X.XXX KWD`, `availability: 'in_stock'`, and `product_count === 1`.
3. Draft/archived products are excluded (seed a second product with `status: 'draft'` → still `product_count === 1`).

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/integration/agent-feed.test.ts` → FAIL (404 on both cases / route missing).

- [ ] **Step 3: Implement the route** in `public.routes.ts` (place after the `GET /products/:slugOrId` block; same style):

```ts
/**
 * GET /public/feed/products.json — AI Product Feed (agent_feed add-on).
 * Fail-closed: 404 when the feature is not enabled for the store, so the
 * URL does not reveal the add-on's existence on stores that didn't buy it.
 */
router.get('/feed/products.json', async (req, res, next) => {
  try {
    const storeId = await getStoreIdFromRequest(req);
    const enabled = await featureService.isFeatureEnabled(storeId, 'agent_feed');
    if (!enabled) {
      throw new AppError(404, 'NOT_FOUND', 'Not found');
    }
    const store = await prisma.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { id: true, name: true, slug: true, currency: true, domain: true },
    });
    const proto = 'https';
    const baseUrl = store.domain
      ? `${proto}://${store.domain}`
      : `${proto}://${req.get('x-original-host') ?? req.get('host')}`;
    // Cache key under public:products:<storeId>:* so invalidateStoreProductCaches busts it on product writes.
    const feed = await getCached(`public:products:${storeId}:feed:v1`, 600, async () => {
      const { products } = await ProductService.listPublic(storeId, {
        status: 'active',
        limit: 1000,
        sort: 'newest',
      });
      return buildProductFeed(store, products, baseUrl);
    });
    setEdgeCache(res, { sMaxAge: 600, staleWhileRevalidate: 86400 });
    res.json(feed);
  } catch (err) {
    next(err);
  }
});
```

Adaptation notes for the implementer (verify against the real file, do not guess): import `buildProductFeed` from `../lib/product-feed`; reuse the exact `AppError` construction, `featureService` import name, `ProductService.listPublic` options shape, and `getCached`/`setEdgeCache` signatures used by the neighboring `GET /products` route (~line 141-231). If `listPublic` returns a different envelope (e.g. `{ items }` or a bare array), adapt the destructure — the integration test is the arbiter. If `Store.domain` isn't a scalar on the model (check schema — custom domains may live in a relation), resolve the base URL the same way `sitemap.ts`/`llms.txt` derive store URLs instead.

- [ ] **Step 4: Run tests** — `npx vitest run tests/integration/agent-feed.test.ts` → PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/public.routes.ts tests/integration/agent-feed.test.ts
git commit -m "feat(api): public agent product feed endpoint, feature-gated fail-closed"
```

### Task 4: Storefront route handler `/feeds/products.json` (apps/web)

**Files:**

- Create: `apps/web/src/app/feeds/products.json/route.ts`
- Modify: `apps/web/middleware.ts` (`KNOWN_APP_ROUTES` array, ~line 41-91: add `'feeds'`)

**Interfaces:**

- Consumes: tenant headers (`x-store-domain` / `x-store-slug`) exactly like `apps/web/src/app/llms.txt/route.ts`; `ResolvedStore.enabledFeatures` via the same store-resolution fetches llms.txt uses; the API endpoint from Task 3.
- Produces: public URL `https://<store-domain>/feeds/products.json`.

- [ ] **Step 1: Add `'feeds'` to `KNOWN_APP_ROUTES`** in `apps/web/middleware.ts` so platform-domain requests to `/feeds/...` are never mistaken for a store slug.

- [ ] **Step 2: Implement the route handler** (`apps/web/src/app/feeds/products.json/route.ts`), modeled directly on `llms.txt/route.ts` (read that file first and reuse its helper style — resolve via public API, never Prisma):

```ts
import { headers } from 'next/headers';

const API_URL = `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1`;

/**
 * Public AI product feed passthrough (agent_feed add-on).
 * Tenant comes from middleware headers (custom domain or platform slug cookie),
 * the feed itself is built and gated in the API — this handler only resolves
 * the tenant and forwards. 404 in every not-available case (fail closed).
 */
export async function GET() {
  const h = await headers();
  const domain = h.get('x-store-domain');
  const slug = h.get('x-store-slug');
  if (!domain && !slug) return new Response('Not found', { status: 404 });

  const upstream = await fetch(`${API_URL}/public/feed/products.json`, {
    headers: domain ? { 'x-store-domain': domain } : { 'x-store-slug': slug! },
    next: { revalidate: 600 },
  });
  if (!upstream.ok) return new Response('Not found', { status: 404 });

  return new Response(await upstream.text(), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=86400',
    },
  });
}
```

Adaptation notes: check how `getStoreIdFromRequest` resolves slugs on the API side — if it only accepts `X-Store-ID`/`x-store-domain` (recon says exactly those two), first resolve the slug to a store id via the same `/public/stores/<slug>` fetch llms.txt uses, then call the feed with `X-Store-ID`. Follow llms.txt's exact resolution helpers; the code above is the shape, llms.txt is the authority.

- [ ] **Step 3: Manual verify (no web unit-test harness exists for apps/web routes)**

Run: `npm run typecheck` → PASS. Then boot the api + web dev servers if the repo's dev scripts allow (`npm run dev` at root or per-workspace) and curl:
`curl -s -H 'Host: <dev store domain>' http://localhost:3000/feeds/products.json` → 404 (feature off), then enable `agent_feed` for the dev store (Prisma studio or FeatureMatrix) → 200 JSON. If a dev boot isn't practical in this environment, state that explicitly in the report — typecheck + Task 3's integration coverage is the floor.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/feeds/products.json/route.ts apps/web/middleware.ts
git commit -m "feat(web): /feeds/products.json storefront route for the agent feed"
```

### Task 5: Advertise the feed in llms.txt

**Files:**

- Modify: `apps/web/src/app/llms.txt/route.ts` (`buildPerStoreBody()`, ~line 231-286)

**Interfaces:**

- Consumes: the store object already available in `buildPerStoreBody` (must expose `enabledFeatures`; if the fetch there doesn't include it, extend it the same way `store-resolver.ts` threads `enabledFeatures`).

- [ ] **Step 1: Add a conditional feed pointer** — when `enabledFeatures` includes `'agent_feed'`, append one markdown line to the per-store body (near where products/categories are listed):

```ts
if (enabledFeatures.includes('agent_feed')) {
  lines.push(
    '',
    '## Product Feed',
    `- [Machine-readable product feed (JSON)](${baseUrl}/feeds/products.json)`
  );
}
```

(Adapt `lines`/`baseUrl` to the function's actual local variables.)

- [ ] **Step 2: Verify** — `npm run typecheck` → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/llms.txt/route.ts
git commit -m "feat(web): llms.txt advertises the product feed when agent_feed is enabled"
```

### Task 6: Documentation parity (same-session rule)

**Files:**

- Modify: `docs/business/02-feature-catalog.md` — add "AI Product Feed" entry (marketing section), EN description matching the registry entry; note it is an individually-priced add-on.
- Modify: `docs/business/plan-feature-matrix.md` — add an add-on row exactly the way `whatsapp`/add-on tier features are represented in that file (read it first; keep the generated-from-code convention: plan columns show "—/add-on").
- Modify: `docs/business/04-pricing-tiers.md` — add the feed to the add-ons section (no price number invented — leave price as "قابل للتسعير حسب العرض / priced per quote" consistent with how other add-ons without a listed number are shown; if all add-ons have numbers, leave a `TBD by Ahmad` marker is NOT allowed — instead describe it without a number, as "individually quoted").
- Modify: `docs/business/06-faq.md` — one Q&A: what the AI Product Feed is, which URL, that it's an add-on any plan can buy.

- [ ] **Step 1: Make the four edits** (read each file's existing style first; bilingual only where the file is bilingual).
- [ ] **Step 2: Verify** — `grep -rn "agent_feed\|AI Product Feed" docs/business/` shows all four files; no pricing numbers/SLA/legal text changed (`git diff --stat docs/business/`).
- [ ] **Step 3: Commit**

```bash
git add docs/business/02-feature-catalog.md docs/business/plan-feature-matrix.md docs/business/04-pricing-tiers.md docs/business/06-faq.md
git commit -m "docs(business): document the AI Product Feed add-on"
```

### Task 7: Full verification + PR

- [ ] **Step 1:** `npm run lint && npm run typecheck && npm run test:unit` → all PASS (integration suite needs services; run `npm run test:integration` if Postgres/Redis are available locally, otherwise CI covers it).
- [ ] **Step 2:** Blast-radius sweep: `grep -rn "agent_feed" apps packages tests docs | sort` — every hit intentional (features.ts, route, web handler, llms.txt, tests, docs). `grep -rn "products.json" apps/web/middleware.ts apps/web/src/app` — middleware exclusion present.
- [ ] **Step 3:** Push and open PR:

```bash
git push -u origin feat/agent-product-feed
gh pr create --title "feat: AI Product Feed add-on (agent_feed) — per-tenant public /feeds/products.json" --body "<summary of tasks 1-6, test evidence, blast-radius line>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01ALD5zwmFH7ot7tTQAxorac"
```

### Follow-up outside this repo (tracked by the orchestrator, NOT part of this plan)

- Add the AI Product Feed add-on section (AR+EN) to the Force Store contract + quote templates at `~/Desktop/work/Force AI/assets/` after merge, together with the billing-cadence check.
- Apply at chatgpt.com/merchants (Ahmad, manual).
