# Agentic Checkout (MCP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a store-scoped MCP server so AI agents can browse a merchant's catalog, build a cart, and place a guest order — reusing the already-shipped public service layer, with COD completing autonomously and online payment handed off as a hosted `paymentUrl`.

**Architecture:** A new Express router at `/api/v1/mcp/:storeSlug` builds a stateless MCP server (`@modelcontextprotocol/sdk`, Streamable HTTP, one server+transport per request) bound to the resolved store. Each MCP tool is a thin Zod-validated wrapper over an existing service (`ProductService`, `CartService`, `OrderService`, `PaymentService`). Availability is gated by a new `agent_checkout` feature key (default-on for all paid plans). Agent-created orders are stamped `Order.source='agent'` for audit only — they get and are denied nothing extra vs a human guest order.

**Tech Stack:** Express + TypeScript (`apps/api`), `@modelcontextprotocol/sdk` (stable 1.x), Prisma + Neon, Zod (`@force/shared`), Vitest integration tests against ephemeral Postgres 16 + Redis 7.

**Source of truth:** spec `docs/superpowers/specs/2026-07-22-agentic-checkout-mcp-design.md`.

## Global Constraints

- **Store resolution NEVER defaults-to-first** — unknown/unresolved slug → 404. (tenant-resolver rule)
- **Agent orders == human guest orders** — no agent-only caps, COD-only rules, or value ceilings. Same `createOrderSchema` validation, same required address fields (`firstName`, `lastName`, `address1`, `country`).
- **Feature gate fails closed** — endpoint 404s when the store lacks `agent_checkout` (plan or per-store override off).
- **No gated-data leak** — tools return only what the public storefront already exposes; explicit negative tests that seller/customer PII is never returned.
- **Migrations hand-authored** — apply with `npx prisma migrate deploy` on a fresh scratch DB; **NEVER `prisma migrate dev`**.
- **All amounts are integer fils** — never float; reuse service-computed totals (never trust client-asserted amounts).
- **commitlint:** all-lowercase subject; blank line before `Co-Authored-By`.
- **Dependency discipline:** `@modelcontextprotocol/sdk` is the official Anthropic SDK (MIT). Pin an exact recent 1.x; `npm audit` must stay 0 high/critical.
- **Every-data-needs-a-UI:** `Order.source='agent'` MUST surface in the admin order view (Task 7) or it is dead data.
- **Discovery:** the `/mcp` endpoint MUST be advertised in `llms.txt` when enabled, else agents can't find it ("built but unreachable").

---

## File Structure

**Create:**

- `apps/api/src/mcp/store-mcp-server.ts` — builds an `McpServer` for a resolved store, registers all tools.
- `apps/api/src/mcp/tools/catalog.tools.ts` — `get_store_info`, `search_products`, `get_product`.
- `apps/api/src/mcp/tools/cart.tools.ts` — `add_to_cart`, `view_cart`.
- `apps/api/src/mcp/tools/order.tools.ts` — `place_order`, `get_order_status`.
- `apps/api/src/mcp/resolve-store.ts` — `resolveStoreBySlug(slug)` helper.
- `apps/api/src/routes/mcp.routes.ts` — the `/mcp/:storeSlug` Express router.
- `apps/api/tests/integration/mcp/agent-checkout.test.ts` — integration tests (real HTTP + Postgres).
- `packages/database/prisma/migrations/<ts>_order_source/migration.sql` — adds `Order.source`.

**Modify:**

- `packages/shared/src/features.ts` — add `agent_checkout` to `FEATURE_KEYS_ARRAY` + `FEATURE_REGISTRY`.
- `packages/shared/src/plan-baselines.ts` — add `agent_checkout` to `STARTER_CORE`.
- `packages/database/prisma/schema.prisma` — add `source String? @default("web")` to `model Order`.
- `apps/api/src/routes/index.ts` — mount `router.use('/mcp', mcpRoutes)`.
- `apps/api/src/services/order.service.ts` — thread an optional `source` into `create` (default `'web'`).
- `apps/web/src/app/llms.txt/route.ts` — advertise the `/mcp/:slug` endpoint when `agent_checkout` enabled.
- `apps/admin/src/app/stores/[id]/orders/...` — order-detail source badge (exact file confirmed in Task 7).
- `docs/business/plan-feature-matrix.md`, `docs/ENVIRONMENT.md` — doc parity.

---

## Task 1: Setup — `agent_checkout` feature key + MCP SDK dependency

**Files:**

- Modify: `packages/shared/src/features.ts`
- Modify: `packages/shared/src/plan-baselines.ts`
- Modify: `apps/api/package.json` (add dependency)
- Test: `packages/shared/src/__tests__/features.test.ts` (or the existing features unit test file — confirm path via `ls packages/shared/src/__tests__`)

**Interfaces:**

- Produces: feature key literal `'agent_checkout'` in `FeatureKey` union; `PLAN_BASELINE.{starter,professional,enterprise}` include it, `.free` does not.

- [ ] **Step 1: Write the failing test**

Add to the shared features test (mirror how `agent_feed` is asserted, if at all; otherwise a fresh test):

```ts
import { describe, it, expect } from 'vitest';
import { FEATURE_KEYS_ARRAY, FEATURE_REGISTRY } from '../features';
import { PLAN_BASELINE } from '../plan-baselines';

describe('agent_checkout feature key', () => {
  it('is registered', () => {
    expect(FEATURE_KEYS_ARRAY).toContain('agent_checkout');
    expect(FEATURE_REGISTRY.agent_checkout.key).toBe('agent_checkout');
  });
  it('is baseline on every paid plan, off on free', () => {
    expect(PLAN_BASELINE.starter).toContain('agent_checkout');
    expect(PLAN_BASELINE.professional).toContain('agent_checkout');
    expect(PLAN_BASELINE.enterprise).toContain('agent_checkout');
    expect(PLAN_BASELINE.free).not.toContain('agent_checkout');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -w @force/shared -- features` (confirm the exact vitest invocation the repo uses)
Expected: FAIL — `agent_checkout` not in array.

- [ ] **Step 3: Implement — register the feature key**

In `packages/shared/src/features.ts`, add `'agent_checkout'` to `FEATURE_KEYS_ARRAY` (next to `'agent_feed'`) and add the registry entry:

```ts
agent_checkout: {
  key: 'agent_checkout',
  name: 'AI Agent Checkout (MCP)',
  nameAr: 'الشراء عبر وكلاء الذكاء الاصطناعي',
  description:
    'Exposes a store-scoped MCP server so AI shopping agents (Claude, ChatGPT, and agentic assistants) can search the catalog, build a cart, and place a guest order. COD completes autonomously; online payment is handed back as a hosted checkout link.',
  descriptionAr:
    'يوفّر خادم MCP خاصاً بالمتجر لتمكين وكلاء الذكاء الاصطناعي من البحث في المنتجات وإنشاء سلة وإتمام الطلب. الدفع عند الاستلام يكتمل تلقائياً، والدفع الإلكتروني يُعاد كرابط دفع.',
  category: 'marketing',
  tier: 'addon',
},
```

In `packages/shared/src/plan-baselines.ts`, add `'agent_checkout'` to the `STARTER_CORE` array (same block as `agent_feed`, per the 2026-07-21 AI-first policy comment).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -w @force/shared -- features`
Expected: PASS.

- [ ] **Step 5: Add the MCP SDK dependency + audit**

```bash
cd apps/api
npm install @modelcontextprotocol/sdk@^1
cd ../..
npm audit --omit=dev --audit-level=high
```

Expected: sdk resolves to a 1.x version; audit reports 0 high/critical. Pin the resolved exact version in `apps/api/package.json` (replace `^1` with the exact installed version).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/features.ts packages/shared/src/plan-baselines.ts \
  packages/shared/src/__tests__ apps/api/package.json package-lock.json
git commit -m "feat(shared): add agent_checkout feature key + mcp sdk dep"
```

---

## Task 2: Migration — `Order.source` provenance column

**Files:**

- Modify: `packages/database/prisma/schema.prisma` (`model Order`)
- Create: `packages/database/prisma/migrations/<timestamp>_order_source/migration.sql`
- Test: (verified via migrate-deploy on a scratch DB in Step 3; no unit test — schema change)

**Interfaces:**

- Produces: `Order.source: string | null` (default `'web'`) — read by `get_order_status`/admin UI, written by `place_order`.

- [ ] **Step 1: Edit the schema**

In `packages/database/prisma/schema.prisma`, `model Order`, add near the other scalar fields:

```prisma
  source        String?   @default("web") // provenance: 'web' | 'agent' — audit only
```

- [ ] **Step 2: Hand-author the migration**

Create `packages/database/prisma/migrations/<timestamp>_order_source/migration.sql` (timestamp format matches sibling migrations, e.g. `20260722HHMMSS_order_source`):

```sql
-- Add order provenance marker (audit only). Nullable + default 'web' so existing rows and
-- every current write path are unaffected; the MCP place_order tool sets 'agent'.
ALTER TABLE "Order" ADD COLUMN "source" TEXT DEFAULT 'web';
```

- [ ] **Step 3: Apply on a FRESH scratch DB and verify**

```bash
# spin an ephemeral scratch DB (docker) or use the CI-style ephemeral Postgres; DO NOT touch dev/prod
export SCRATCH_URL="postgresql://...localhost:5544/scratch"
DATABASE_URL="$SCRATCH_URL" DIRECT_URL="$SCRATCH_URL" npx prisma migrate deploy --schema packages/database/prisma/schema.prisma
DATABASE_URL="$SCRATCH_URL" npx prisma db execute --stdin <<'SQL'
SELECT column_name, column_default, is_nullable FROM information_schema.columns
WHERE table_name='Order' AND column_name='source';
SQL
```

Expected: migrate deploy succeeds clean; the column exists, `column_default` = `'web'::text`, `is_nullable` = `YES`.

- [ ] **Step 4: Regenerate the Prisma client**

Run: `npm run db:generate`
Expected: client regenerates; `source` appears on the `Order` type.

- [ ] **Step 5: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations
git commit -m "feat(database): add order.source provenance column"
```

---

## Task 3: Store resolver + MCP route skeleton (handshake, feature-gated)

**Files:**

- Create: `apps/api/src/mcp/resolve-store.ts`
- Create: `apps/api/src/mcp/store-mcp-server.ts`
- Create: `apps/api/src/routes/mcp.routes.ts`
- Modify: `apps/api/src/routes/index.ts`
- Test: `apps/api/tests/integration/mcp/agent-checkout.test.ts`

**Interfaces:**

- Produces:
  - `resolveStoreBySlug(slug: string): Promise<{ id: string; name: string; slug: string; currency: string; domain: string | null }>` — throws `AppError(404,'STORE_NOT_FOUND')` on miss.
  - `buildStoreMcpServer(store): McpServer` — returns a server with tools registered (empty in this task; tools added Tasks 4-6).
  - Route: `POST /api/v1/mcp/:storeSlug` (stateless Streamable HTTP). `GET`/`DELETE` → 405.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/tests/integration/mcp/agent-checkout.test.ts`, mirroring `tests/integration/agent-feed.test.ts` (raw Prisma fixtures, `storeFeature.upsert` toggle, `fetch` against `http://localhost:4000/api/v1`). Use the official MCP client for the handshake:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const API = 'http://localhost:4000/api/v1';
const prisma = new PrismaClient();
let storeId: string;
let slug: string;
let ownerId: string;

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: {
      email: `mcp-${Date.now()}@t.co`,
      password: 'x',
      role: 'store_admin',
      firstName: 'A',
      lastName: 'B',
    },
  });
  ownerId = owner.id;
  slug = `mcp-store-${Date.now()}`;
  const store = await prisma.store.create({
    data: { name: 'MCP Store', slug, ownerId, plan: 'starter', status: 'active', currency: 'KWD' },
  });
  storeId = store.id;
});

afterAll(async () => {
  await prisma.store.delete({ where: { id: storeId } }).catch(() => {});
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {});
  await prisma.$disconnect();
});

function mcpClient(pathSlug: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${API}/mcp/${pathSlug}`));
  const client = new Client({ name: 'test', version: '1.0.0' });
  return { client, transport };
}

describe('MCP endpoint — handshake + gating', () => {
  it('lists tools when the store has agent_checkout', async () => {
    const { client, transport } = mcpClient(slug);
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name)).toEqual(
      expect.arrayContaining([
        'get_store_info',
        'search_products',
        'get_product',
        'add_to_cart',
        'view_cart',
        'place_order',
        'get_order_status',
      ])
    );
    await client.close();
  });

  it('404s for an unknown slug (never default-to-first)', async () => {
    const res = await fetch(`${API}/mcp/no-such-store-xyz`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        },
      }),
    });
    expect(res.status).toBe(404);
  });

  it('404s when agent_checkout is disabled for the store', async () => {
    await prisma.storeFeature.upsert({
      where: { storeId_featureKey: { storeId, featureKey: 'agent_checkout' } },
      create: { storeId, featureKey: 'agent_checkout', enabled: false },
      update: { enabled: false },
    });
    const res = await fetch(`${API}/mcp/${slug}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        },
      }),
    });
    expect(res.status).toBe(404);
    await prisma.storeFeature
      .delete({ where: { storeId_featureKey: { storeId, featureKey: 'agent_checkout' } } })
      .catch(() => {});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/tests/integration/mcp/agent-checkout.test.ts` (with the API server running against ephemeral PG/Redis per the CI harness)
Expected: FAIL — endpoint 404s for everything / connection error (route not mounted).

- [ ] **Step 3: Implement the store resolver**

`apps/api/src/mcp/resolve-store.ts`:

```ts
import { prisma } from '../lib/prisma';
import { AppError } from '../utils/app-error'; // confirm the AppError import path used across services

export interface McpStore {
  id: string;
  name: string;
  slug: string;
  currency: string;
  domain: string | null;
}

export async function resolveStoreBySlug(slug: string): Promise<McpStore> {
  const store = await prisma.store.findFirst({
    where: { slug, status: 'active', deletedAt: null },
    select: { id: true, name: true, slug: true, currency: true, domain: true },
  });
  if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
  return store;
}
```

- [ ] **Step 4: Implement the MCP server builder (no tools yet)**

`apps/api/src/mcp/store-mcp-server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpStore } from './resolve-store';

export function buildStoreMcpServer(store: McpStore): McpServer {
  const server = new McpServer({ name: `force-store-${store.slug}`, version: '1.0.0' });
  // Tools registered in Tasks 4-6 via registerCatalogTools/registerCartTools/registerOrderTools(server, store).
  return server;
}
```

- [ ] **Step 5: Implement the route (stateless Streamable HTTP + feature gate)**

`apps/api/src/routes/mcp.routes.ts`:

```ts
import { Router, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { publicLimiter } from '../middleware/security';
import { featureService } from '../services/feature.service';
import { resolveStoreBySlug } from '../mcp/resolve-store';
import { buildStoreMcpServer } from '../mcp/store-mcp-server';
import { AppError } from '../utils/app-error';

const router = Router();
router.use(publicLimiter);

async function handleMcpPost(req: Request, res: Response) {
  const store = await resolveStoreBySlug(req.params.storeSlug); // throws 404 on miss
  const enabled = await featureService.isFeatureEnabled(store.id, 'agent_checkout');
  if (!enabled) throw new AppError(404, 'NOT_FOUND', 'Not found'); // fail closed, no capability leak

  const server = buildStoreMcpServer(store);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

router.post('/:storeSlug', (req, res, next) => {
  handleMcpPost(req, res).catch(next);
});
router.get('/:storeSlug', (_req, res) => res.status(405).json({ error: 'Method Not Allowed' }));
router.delete('/:storeSlug', (_req, res) => res.status(405).json({ error: 'Method Not Allowed' }));

export default router;
```

Mount in `apps/api/src/routes/index.ts` next to the other `router.use(...)` lines:

```ts
import mcpRoutes from './mcp.routes';
router.use('/mcp', mcpRoutes);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run apps/api/tests/integration/mcp/agent-checkout.test.ts`
Expected: all 3 tests PASS (handshake lists the 7 tool names — registered in later tasks, so temporarily assert only that `initialize` succeeds and `listTools` returns an array here; tighten to the full name list after Task 6). Note: adjust the first test to `expect(Array.isArray(tools.tools)).toBe(true)` until Tasks 4-6 register the tools, then restore the `arrayContaining` assertion.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/mcp/resolve-store.ts apps/api/src/mcp/store-mcp-server.ts \
  apps/api/src/routes/mcp.routes.ts apps/api/src/routes/index.ts \
  apps/api/tests/integration/mcp/agent-checkout.test.ts
git commit -m "feat(api): store-scoped mcp endpoint skeleton, feature-gated + slug-resolved"
```

---

## Task 4: Catalog tools — `get_store_info`, `search_products`, `get_product`

**Files:**

- Create: `apps/api/src/mcp/tools/catalog.tools.ts`
- Modify: `apps/api/src/mcp/store-mcp-server.ts` (register)
- Test: `apps/api/tests/integration/mcp/agent-checkout.test.ts` (extend)

**Interfaces:**

- Consumes: `McpStore`; `ProductService.listPublic(storeId, { search?, limit? })` → `{ products, facets, meta }`; `ProductService.getPublicById(storeId, id)` → product with variants; store currency/name from `McpStore`.
- Produces: `registerCatalogTools(server: McpServer, store: McpStore): void`.

- [ ] **Step 1: Write the failing test** (extend the describe block)

```ts
it('search_products returns matching items; get_product returns detail', async () => {
  const p = await prisma.product.create({
    data: {
      storeId,
      name: 'Blue Widget',
      slug: `blue-${Date.now()}`,
      status: 'active',
      price: 2500,
      inventory: 5,
      currency: 'KWD',
    },
  });
  const { client, transport } = mcpClient(slug);
  await client.connect(transport);

  const search = await client.callTool({
    name: 'search_products',
    arguments: { query: 'Blue', limit: 10 },
  });
  const searchJson = JSON.parse((search.content as any)[0].text);
  expect(searchJson.products.some((x: any) => x.id === p.id)).toBe(true);

  const detail = await client.callTool({ name: 'get_product', arguments: { productId: p.id } });
  const detailJson = JSON.parse((detail.content as any)[0].text);
  expect(detailJson.id).toBe(p.id);
  expect(detailJson.price).toBe(2500);

  const info = await client.callTool({ name: 'get_store_info', arguments: {} });
  expect(JSON.parse((info.content as any)[0].text).currency).toBe('KWD');

  await client.close();
  await prisma.product.delete({ where: { id: p.id } }).catch(() => {});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/api/tests/integration/mcp/agent-checkout.test.ts -t 'search_products'`
Expected: FAIL — `Tool search_products not found`.

- [ ] **Step 3: Implement the catalog tools**

`apps/api/src/mcp/tools/catalog.tools.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpStore } from '../resolve-store';
import { ProductService } from '../../services/product.service';

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
});

function toSummary(p: any) {
  return {
    id: p.id,
    title: p.name,
    title_ar: p.nameAr ?? undefined,
    price: p.price,
    currency: p.currency,
    availability: p.inStock === false ? 'out_of_stock' : 'in_stock',
    image: p.images?.[0]?.url ?? undefined,
  };
}

export function registerCatalogTools(server: McpServer, store: McpStore): void {
  server.registerTool(
    'get_store_info',
    {
      description: 'Basic info about this store (name, currency, whether it accepts orders).',
      inputSchema: {},
    },
    async () => ok({ name: store.name, slug: store.slug, currency: store.currency })
  );

  server.registerTool(
    'search_products',
    {
      description:
        "Search this store's active products by keyword (matches English and Arabic). Returns up to `limit` summaries.",
      inputSchema: {
        query: z.string().min(1).describe('search keywords'),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, limit }) => {
      const { products } = await ProductService.listPublic(store.id, {
        search: query,
        status: 'active',
        limit: limit ?? 20,
      });
      return ok({ products: products.map(toSummary) });
    }
  );

  server.registerTool(
    'get_product',
    {
      description: 'Full detail for one product (variants, price, availability).',
      inputSchema: { productId: z.string().min(1) },
    },
    async ({ productId }) => {
      const p = await ProductService.getPublicById(store.id, productId); // throws AppError 404 → surfaced as tool error
      return ok({
        id: p.id,
        title: p.name,
        title_ar: p.nameAr ?? undefined,
        description: p.description ?? undefined,
        price: p.price,
        currency: p.currency,
        availability: p.inStock === false ? 'out_of_stock' : 'in_stock',
        variants: (p.variants ?? []).map((v: any) => ({
          id: v.id,
          title: v.title,
          price: v.price,
        })),
        images: (p.images ?? []).map((i: any) => i.url),
      });
    }
  );
}
```

Register in `buildStoreMcpServer` (`store-mcp-server.ts`): `import { registerCatalogTools } from './tools/catalog.tools'` then `registerCatalogTools(server, store);` before `return server;`.

> Note: the exact product summary/detail field names (`nameAr`, `inStock`, `images[].url`, `variants[].title`) come from `PUBLIC_PRODUCT_DETAIL_SELECT`/`enrichStockFlags` — confirm against `product.service.ts` and adjust the mappers if a name differs. Wrap `getPublicById`'s `AppError` so a missing product returns an MCP `isError` result rather than a 500 (the SDK converts a thrown Error into a tool error automatically; verify the shape in the test).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run apps/api/tests/integration/mcp/agent-checkout.test.ts -t 'search_products'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mcp/tools/catalog.tools.ts apps/api/src/mcp/store-mcp-server.ts apps/api/tests/integration/mcp/agent-checkout.test.ts
git commit -m "feat(api): mcp catalog tools — store info, search, product detail"
```

---

## Task 5: Cart tools — `add_to_cart`, `view_cart`

**Files:**

- Create: `apps/api/src/mcp/tools/cart.tools.ts`
- Modify: `apps/api/src/mcp/store-mcp-server.ts` (register)
- Test: extend the integration test

**Interfaces:**

- Consumes: `CartService.addItem(storeId, sessionId, productId, quantity, customerId?, variantId?)` and `CartService.getOrCreate(storeId, sessionId)` — both return `{ ...cart, items, subtotal }`.
- Produces: `registerCartTools(server, store)`; a minted cart id shaped `sess_<32hex>` returned as `cartId` (same convention as the storefront client).

- [ ] **Step 1: Write the failing test**

```ts
it('add_to_cart mints a cartId, view_cart reflects it; oversell rejected', async () => {
  const prod = await prisma.product.create({
    data: {
      storeId,
      name: 'Cart Item',
      slug: `ci-${Date.now()}`,
      status: 'active',
      price: 1000,
      inventory: 2,
      currency: 'KWD',
    },
  });
  const { client, transport } = mcpClient(slug);
  await client.connect(transport);

  const add = await client.callTool({
    name: 'add_to_cart',
    arguments: { productId: prod.id, quantity: 1 },
  });
  const addJson = JSON.parse((add.content as any)[0].text);
  expect(addJson.cartId).toMatch(/^sess_[0-9a-f]{32}$/);
  expect(addJson.items.length).toBe(1);

  const view = await client.callTool({ name: 'view_cart', arguments: { cartId: addJson.cartId } });
  expect(JSON.parse((view.content as any)[0].text).items[0].quantity).toBe(1);

  const over = await client.callTool({
    name: 'add_to_cart',
    arguments: { cartId: addJson.cartId, productId: prod.id, quantity: 99 },
  });
  expect(over.isError).toBe(true); // INSUFFICIENT_INVENTORY

  await client.close();
  await prisma.product.delete({ where: { id: prod.id } }).catch(() => {});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/api/tests/integration/mcp/agent-checkout.test.ts -t 'add_to_cart'`
Expected: FAIL — tool not found.

- [ ] **Step 3: Implement the cart tools**

`apps/api/src/mcp/tools/cart.tools.ts`:

```ts
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpStore } from '../resolve-store';
import { CartService } from '../../services/cart.service';

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
});
const newCartId = () => `sess_${randomBytes(16).toString('hex')}`;

function cartView(cartId: string, cart: any) {
  return {
    cartId,
    items: cart.items.map((i: any) => ({
      itemId: i.id,
      productId: i.productId,
      variantId: i.variantId ?? undefined,
      title: i.product?.name,
      quantity: i.quantity,
      unitPrice: i.variant?.price ?? i.product?.price,
    })),
    subtotal: cart.subtotal,
    currency: cart.currency ?? undefined,
  };
}

export function registerCartTools(server: McpServer, store: McpStore): void {
  server.registerTool(
    'add_to_cart',
    {
      description:
        'Add a product (optionally a variant) to a cart. Omit cartId to start a new cart — the returned cartId must be reused for later cart/order calls.',
      inputSchema: {
        cartId: z.string().optional(),
        productId: z.string().min(1),
        variantId: z.string().optional(),
        quantity: z.number().int().min(1).max(999),
      },
    },
    async ({ cartId, productId, variantId, quantity }) => {
      const sessionId = cartId ?? newCartId();
      const cart = await CartService.addItem(
        store.id,
        sessionId,
        productId,
        quantity,
        undefined,
        variantId
      ); // throws → tool error on OOS/invalid
      return ok(cartView(sessionId, cart));
    }
  );

  server.registerTool(
    'view_cart',
    {
      description: "View a cart's items and subtotal.",
      inputSchema: { cartId: z.string().min(1) },
    },
    async ({ cartId }) => ok(cartView(cartId, await CartService.getOrCreate(store.id, cartId)))
  );
}
```

Register in `buildStoreMcpServer`: `registerCartTools(server, store);`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run apps/api/tests/integration/mcp/agent-checkout.test.ts -t 'add_to_cart'`
Expected: PASS (add mints id, view reflects, oversell → `isError`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mcp/tools/cart.tools.ts apps/api/src/mcp/store-mcp-server.ts apps/api/tests/integration/mcp/agent-checkout.test.ts
git commit -m "feat(api): mcp cart tools — add_to_cart (mints session), view_cart"
```

---

## Task 6: Order tools — `place_order` (COD + online handoff) + `get_order_status` — MONEY PATH

**Files:**

- Create: `apps/api/src/mcp/tools/order.tools.ts`
- Modify: `apps/api/src/services/order.service.ts` (thread optional `source`)
- Modify: `apps/api/src/mcp/store-mcp-server.ts` (register)
- Test: extend the integration test (COD happy path, source stamp, online paymentUrl, human-order-parity validation)

**Interfaces:**

- Consumes:
  - `OrderService.create(storeId, customerId|undefined, sessionId, data: CreateOrderData & { source?: string })` → order row (no paymentUrl).
  - `OrderService.getById(storeId, orderId)` → order incl. `items`, `payments`, `source`.
  - `PaymentService.createPayment(request: CreatePaymentRequest, provider?, storeId?)` → `{ transactionId, paymentUrl, provider, ... }`.
  - `PaymentFactory.getDefaultProvider(storeId)` → default online provider name (or null).
- Produces: `registerOrderTools(server, store)`.

- [ ] **Step 1: Thread `source` through OrderService.create (failing unit-ish test first)**

Add an integration assertion (below) that an agent COD order has `source==='agent'`. First make `create` accept it. In `order.service.ts`, `CreateOrderData` gains `source?: string`, and the `prisma.order.create({ data: { ... } })` call sets `source: data.source ?? 'web'`. All existing callers omit it → default `'web'` (no behavior change).

- [ ] **Step 2: Write the failing test**

```ts
it('place_order (cod) creates an agent-sourced order; get_order_status reads it', async () => {
  const prod = await prisma.product.create({
    data: {
      storeId,
      name: 'Order Item',
      slug: `oi-${Date.now()}`,
      status: 'active',
      price: 3000,
      inventory: 10,
      currency: 'KWD',
    },
  });
  // ensure COD is available for the store
  await prisma.paymentConfig
    .upsert({
      where: { storeId_provider: { storeId, provider: 'cod' } },
      create: { storeId, provider: 'cod', enabled: true, isDefault: true },
      update: { enabled: true },
    })
    .catch(() => {});
  const { client, transport } = mcpClient(slug);
  await client.connect(transport);

  const add = await client.callTool({
    name: 'add_to_cart',
    arguments: { productId: prod.id, quantity: 2 },
  });
  const cartId = JSON.parse((add.content as any)[0].text).cartId;

  const placed = await client.callTool({
    name: 'place_order',
    arguments: {
      cartId,
      paymentMethod: 'cod',
      customer: { name: 'Sara Ali', phone: '+96550000000', address: 'Block 1, Salmiya' },
    },
  });
  const placedJson = JSON.parse((placed.content as any)[0].text);
  expect(placedJson.orderId).toBeTruthy();
  expect(placedJson.paymentMethod).toBe('cod');
  expect(placedJson.paymentUrl).toBeUndefined();

  const dbOrder = await prisma.order.findUnique({ where: { id: placedJson.orderId } });
  expect(dbOrder?.source).toBe('agent');

  const status = await client.callTool({
    name: 'get_order_status',
    arguments: { orderId: placedJson.orderId },
  });
  const statusJson = JSON.parse((status.content as any)[0].text);
  expect(statusJson.status).toBeTruthy();
  // No gated-data leak: status must NOT carry customer PII (email/phone/name) or address.
  expect(statusJson).not.toHaveProperty('email');
  expect(statusJson).not.toHaveProperty('customer');
  expect(statusJson).not.toHaveProperty('shippingAddress');

  await client.close();
  await prisma.order.delete({ where: { id: placedJson.orderId } }).catch(() => {});
  await prisma.product.delete({ where: { id: prod.id } }).catch(() => {});
});

it('place_order rejects missing required customer fields (same as human guest order)', async () => {
  const prod = await prisma.product.create({
    data: {
      storeId,
      name: 'Order Item2',
      slug: `oi2-${Date.now()}`,
      status: 'active',
      price: 3000,
      inventory: 10,
      currency: 'KWD',
    },
  });
  const { client, transport } = mcpClient(slug);
  await client.connect(transport);
  const add = await client.callTool({
    name: 'add_to_cart',
    arguments: { productId: prod.id, quantity: 1 },
  });
  const cartId = JSON.parse((add.content as any)[0].text).cartId;
  const bad = await client.callTool({
    name: 'place_order',
    arguments: { cartId, paymentMethod: 'cod', customer: { phone: '+96550000000' } },
  }); // no name/address
  expect(bad.isError).toBe(true);
  await client.close();
  await prisma.product.delete({ where: { id: prod.id } }).catch(() => {});
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run apps/api/tests/integration/mcp/agent-checkout.test.ts -t 'place_order'`
Expected: FAIL — tool not found.

- [ ] **Step 4: Implement the order tools**

`apps/api/src/mcp/tools/order.tools.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpStore } from '../resolve-store';
import { OrderService } from '../../services/order.service';
import { PaymentService } from '../../services/payment-providers/payment.factory';
import { config } from '../../config';

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
});

// Agent orders reuse the SAME required-field contract as a human guest order:
// firstName+lastName (from `name`), address1, country. Nothing stricter, nothing looser.
const customerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1).optional(),
  email: z.string().email().optional(),
  address: z.string().min(1),
  city: z.string().optional(),
  country: z.string().min(2).default('KW'),
});

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') || parts[0] };
}

function storefrontBaseUrl(store: McpStore): string {
  return store.domain ? `https://${store.domain}` : `${config.webUrl}/${store.slug}`; // mirror payment.routes storefront-url derivation
}

export function registerOrderTools(server: McpServer, store: McpStore): void {
  server.registerTool(
    'place_order',
    {
      description:
        'Place a guest order from a cart. paymentMethod "cod" completes immediately (cash on delivery). "online" creates the order and returns a paymentUrl a human opens to pay.',
      inputSchema: {
        cartId: z.string().min(1),
        paymentMethod: z.enum(['cod', 'online']),
        customer: customerSchema,
      },
    },
    async ({ cartId, paymentMethod, customer }) => {
      const { firstName, lastName } = splitName(customer.name);
      const order = await OrderService.create(store.id, undefined, cartId, {
        shippingAddress: {
          firstName,
          lastName,
          address1: customer.address,
          city: customer.city ?? '',
          state: '',
          postalCode: '',
          country: customer.country,
          phone: customer.phone,
          email: customer.email,
        },
        paymentMethod: paymentMethod === 'cod' ? 'cod' : 'online',
        source: 'agent',
      });

      if (paymentMethod === 'cod') {
        return ok({
          orderId: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          paymentMethod: 'cod',
          total: order.total,
          currency: order.currency,
        });
      }

      // Online: create a payment intent → return the hosted paymentUrl for a human to open.
      // An unpaid order is a valid state (expire-stale-orders sweep reclaims it) — no compensating rollback needed here.
      const base = storefrontBaseUrl(store);
      const shipping = (order.shippingAddress ?? {}) as Record<string, string | undefined>;
      const payment = await PaymentService.createPayment(
        {
          orderId: order.id,
          orderNumber: order.orderNumber,
          amount: order.total,
          currency: order.currency as any,
          customer: {
            id: `guest-${order.id}`,
            name: customer.name,
            email: customer.email ?? shipping.email ?? '',
            phone: customer.phone,
          },
          items: order.items.map((i: any) => ({
            name: i.productName,
            quantity: i.quantity,
            unitPrice: i.price,
            sku: i.sku || undefined,
          })),
          callbackUrl: `${base}/checkout/success`,
          errorUrl: `${base}/checkout/error`,
          webhookUrl: `${config.apiUrl}/api/v1/webhooks/payment`,
        },
        undefined,
        store.id
      ); // provider omitted → store default
      return ok({
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        paymentMethod: 'online',
        total: order.total,
        currency: order.currency,
        paymentUrl: payment.paymentUrl,
      });
    }
  );

  server.registerTool(
    'get_order_status',
    {
      description: 'Read the current status of an order placed through this store.',
      inputSchema: { orderId: z.string().min(1) },
    },
    async ({ orderId }) => {
      const o = await OrderService.getById(store.id, orderId); // 404 → tool error
      return ok({
        orderId: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        paymentStatus: o.paymentStatus,
        total: o.total,
        currency: o.currency,
        source: o.source ?? 'web',
      });
    }
  );
}
```

Register in `buildStoreMcpServer`: `registerOrderTools(server, store);`.

> Confirm during implementation: the exact `config.webUrl`/`config.apiUrl` names, the `PaymentService.createPayment` import path (`payment.factory.ts`), the webhook URL shape (`.../webhooks/payment/<provider>` vs generic), and whether `OrderService.create`'s return includes `items` with `productName`/`price`/`sku`. Adjust the mappers to the real field names — do not invent fields.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run apps/api/tests/integration/mcp/agent-checkout.test.ts -t 'place_order'`
Expected: PASS — COD order created with `source='agent'`, no paymentUrl; missing-field order → `isError`.

- [ ] **Step 6: Restore the full tool-list assertion from Task 3**

Change the Task-3 handshake test back to the `arrayContaining([...7 names])` assertion now that all tools are registered. Run the whole file:

Run: `npx vitest run apps/api/tests/integration/mcp/agent-checkout.test.ts`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/mcp/tools/order.tools.ts apps/api/src/services/order.service.ts apps/api/src/mcp/store-mcp-server.ts apps/api/tests/integration/mcp/agent-checkout.test.ts
git commit -m "feat(api): mcp order tools — place_order (cod + online handoff), get_order_status, source stamp"
```

---

## Task 7: Discovery + admin UI surface + docs (every-data-needs-a-UI + blast-radius)

**Files:**

- Modify: `apps/web/src/app/llms.txt/route.ts` (advertise `/mcp/:slug` when enabled)
- Modify: admin order-detail page (surface `source` badge — confirm exact path, e.g. `apps/admin/src/app/stores/[id]/orders/[orderId]/page.tsx`)
- Modify: `docs/business/plan-feature-matrix.md`, `docs/ENVIRONMENT.md`
- Test: extend integration test (llms.txt advertises endpoint when enabled)

**Interfaces:**

- Consumes: `featureService.isFeatureEnabled(storeId, 'agent_checkout')` (llms.txt already checks `agent_feed` similarly); `Order.source`.

- [ ] **Step 1: Write the failing test**

```ts
it('llms.txt advertises the mcp endpoint when agent_checkout is enabled', async () => {
  // llms.txt is served by the web app; assert the API-side helper (or web route) includes /mcp/<slug>.
  const res = await fetch(`http://localhost:3000/${slug}/llms.txt`); // web app; adjust to how llms.txt is addressed per-store
  const text = await res.text();
  expect(text).toContain(`/mcp/${slug}`);
});
```

> If the web app is not running in the API integration harness, instead unit-test the llms.txt builder function directly (import it, pass a store with `agent_checkout` enabled, assert the `/mcp/<slug>` line). Prefer the unit test — it needs no second server.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/web -t 'llms.txt advertises'` (or the API test if the builder is server-side)
Expected: FAIL — endpoint not advertised.

- [ ] **Step 3: Implement llms.txt advertisement**

In `apps/web/src/app/llms.txt/route.ts`, where it already conditionally links the product feed on `agent_feed`, add a parallel block: when `agent_checkout` is enabled for the store, emit a line documenting the MCP endpoint, e.g.:

```
## Agentic checkout (MCP)
This store accepts orders from AI agents via the Model Context Protocol:
MCP endpoint: {origin}/api/v1/mcp/{slug}
Tools: search_products, get_product, add_to_cart, view_cart, place_order, get_order_status
```

- [ ] **Step 4: Implement the admin source badge**

On the admin order-detail (and/or order-list row), render a small badge when `order.source === 'agent'` (e.g. "🤖 Agent"). Confirm the order-detail component path and its existing badge pattern; reuse it. This satisfies every-data-needs-a-UI for `Order.source`.

- [ ] **Step 5: Run to verify it passes**

Run: the test from Step 1.
Expected: PASS.

- [ ] **Step 6: Docs parity + blast-radius sweep**

- Add `agent_checkout` row to `docs/business/plan-feature-matrix.md` (all paid plans).
- Note the new dependency + endpoint in `docs/ENVIRONMENT.md` if any env is involved (none expected — the MCP server reads no new env).
- Blast-radius grep: `source` consumers (admin views, any order serializer, analytics), `agent_checkout` (feature registry, plan baselines, llms.txt, feature-matrix), the new `/mcp` route (route index, rate limiter). State the result in the PR body.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/llms.txt/route.ts apps/admin/src/app/stores docs/business/plan-feature-matrix.md docs/ENVIRONMENT.md apps/api/tests
git commit -m "feat: advertise mcp endpoint in llms.txt + admin agent-order badge + docs"
```

---

## Final verification (before PR)

- [ ] `npm run typecheck` — clean across workspaces.
- [ ] `npm run lint` — clean.
- [ ] `npx vitest run apps/api/tests/integration/mcp/agent-checkout.test.ts` — all green.
- [ ] `npm run test:unit -w @force/shared` — feature-key tests green.
- [ ] `npm audit --omit=dev --audit-level=high` — 0 high/critical.
- [ ] Manual MCP smoke: point a real MCP client (or `npx @modelcontextprotocol/inspector`) at `http://localhost:4000/api/v1/mcp/<slug>` → `tools/list` shows 7 tools → run `search_products` → `add_to_cart` → `place_order` (cod).
- [ ] Blast-radius statement in the PR body (`source`, `agent_checkout`, `/mcp` route swept across code + docs + feature matrix → clean/fixed).

## Fast-follow tickets (not blockers)

- Unify the online-payment request-building: extract a shared `createPaymentForOrder(orderId, opts)` service that BOTH `POST /payments/create` and the MCP `place_order` online branch call (removes the ~30-line duplication introduced in Task 6).
- Consider per-agent identity / audit receipt (API key) if agent order volume grows.
- Pagination for `search_products` beyond the first page (currently capped like the feed).
