/**
 * Integration tests for the store-scoped MCP endpoint (agent checkout —
 * resolver/route skeleton from Task 3, catalog tools from Task 4, cart tools
 * from Task 5, order tools from Task 6).
 *
 * Requires a real Postgres DB (via DATABASE_URL) and real Redis (via
 * REDIS_URL); CI provides both via service containers. Hits a real running
 * API server at localhost:4000 — mirrors the setup pattern of
 * tests/integration/agent-feed.test.ts. Uses the official MCP client for the
 * handshake so the test exercises the real Streamable HTTP transport, not a
 * hand-rolled JSON-RPC stub.
 *
 * Tests:
 *  1. A store with `agent_checkout` enabled completes the MCP `initialize`
 *     handshake and `listTools()` returns the full 7-tool name list (all of
 *     catalog + cart + order are registered by `buildStoreMcpServer`).
 *  2. An unknown slug 404s — the resolver must NEVER default to any other
 *     store (feedback-tenant-resolver-throw-not-default).
 *  3. A known slug with `agent_checkout` explicitly disabled 404s — the
 *     feature gate fails closed, with no capability leak distinguishing
 *     "store not found" from "feature off".
 *  4. The two 404 bodies from (2) and (3) are byte-identical (deep-equal
 *     `error` object) — locks in the capability-leak fix so a regression
 *     that reintroduces a distinct code/message per path fails this test.
 *  5. `search_products` finds a just-created product, `get_product` returns
 *     its detail (price in piastres, unchanged), and `get_store_info` returns
 *     the store's currency.
 *  6. `add_to_cart` mints a cartId, `view_cart` reflects it, oversell is
 *     rejected.
 *  7. `place_order` (cod) creates an agent-sourced order (Order.source ===
 *     'agent') with no paymentUrl; `get_order_status` reads it back with an
 *     explicit PII allow-list (no email/customer/shippingAddress/items).
 *  8. `place_order` rejects a customer object missing required fields
 *     (name/address) — same required-field contract as a human guest order.
 *  9. `place_order` (online) with no payment provider configured for the
 *     store errors cleanly (isError) and creates NO order — the provider is
 *     resolved before OrderService.create runs, so there is no orphan
 *     unpaid order. The real online-provider-success path (paymentUrl
 *     returned) is NOT exercised here — see task-6-report.md for why.
 * 10. Cross-tenant isolation (the top security property — locked against a
 *     future refactor dropping a `storeId` from a `where` clause): a SECOND
 *     store (B, own owner/product/COD order) exists. Calling `get_product`/
 *     `get_order_status` on STORE A's endpoint with STORE B's productId/
 *     orderId is denied (isError), and `view_cart` on Store A's endpoint
 *     with Store B's cartId returns a fresh EMPTY cart (storeId-scoped
 *     `getOrCreate` mints a new cart for Store A, never resolving Store B's
 *     real one) — never Store B's data.
 * 11. **Agent-write authorisation (Ruling M1, 2026-09-09).** The two WRITE
 *     tools (`add_to_cart`, `place_order`) require the store's `x-agent-key`
 *     credential; every READ tool and the `initialize` handshake stay
 *     anonymous. A wrong key, a revoked key and STORE B's key are all refused
 *     on Store A; the `agent_checkout_open_writes` StoreFeature disables the
 *     requirement for ONE store and not the other; a refused write leaves an
 *     `agent.write.denied` audit row carrying ip + user agent.
 *
 * RETRY-SAFETY: vitest runs with `retry: 1`, and a retry re-runs `beforeAll`
 * in the SAME process. Every fixture id below is therefore built from a
 * per-CALL `randomUUID()` (`uid()`), never from a module-scope `Date.now()` —
 * the old form collided on `Store.slug`'s unique index on the second attempt
 * and reported an artefact of attempt 2 while hiding the real failure.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@force/database';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { encryption } from '../../../apps/api/src/services/encryption.service';
import { API_BASE } from '../../helpers/api-base';

const API = API_BASE;

/**
 * Per-CALL unique id. NEVER hoist this into a module-scope constant: vitest
 * retries the file in the SAME process, so a module-scope value is reused by
 * attempt 2 and collides on `Store.slug` / `User.email`.
 */
const uid = () => randomUUID().slice(0, 12);

let storeId: string;
let ownerId: string;
let slug: string;
// The per-store agent credential the two WRITE tools require. Seeded encrypted
// with the SAME `encryption.service` the API decrypts with — CI passes one
// ENCRYPTION_KEY to both the server process and this test process.
let agentKeyA: string;
// Captured across the two 404 tests below and compared in a third test —
// see "returns a byte-identical 404 body ..." for why.
let unknownSlugBody: { error: { code: string; message: string } };
let disabledFeatureBody: { error: { code: string; message: string } };

beforeAll(async () => {
  slug = `mcp-store-${uid()}`;
  agentKeyA = `fak_${randomUUID()}`;
  const owner = await prisma.user.create({
    data: {
      email: `mcp-owner-${uid()}@example.test`,
      passwordHash: 'x',
      firstName: 'A',
      lastName: 'B',
      role: 'store_admin',
      emailVerified: true,
    },
  });
  ownerId = owner.id;

  const store = await prisma.store.create({
    data: {
      name: 'MCP Store',
      slug,
      ownerId,
      plan: 'starter',
      status: 'active',
      currency: 'EGP',
      agentApiKeyRotatedAt: new Date(),
      credentials: { create: { agentApiKey: encryption.encrypt(agentKeyA) } },
    },
  });
  storeId = store.id;

  await prisma.storeFeature.upsert({
    where: { storeId_featureKey: { storeId, featureKey: 'agent_checkout' } },
    create: { storeId, featureKey: 'agent_checkout', enabled: true },
    update: { enabled: true },
  });
});

afterAll(async () => {
  await prisma.storeFeature.deleteMany({ where: { storeId } }).catch(() => {});
  await prisma.store.delete({ where: { id: storeId } }).catch(() => {});
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {});
});

/**
 * `agentKey` is optional ON PURPOSE: omitting it produces exactly the request
 * an unauthenticated agent makes, which is what the read tools and the
 * handshake must keep working with.
 */
function mcpClient(pathSlug: string, agentKey?: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${API}/mcp/${pathSlug}`), {
    requestInit: agentKey ? { headers: { 'x-agent-key': agentKey } } : undefined,
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  return { client, transport };
}

describe('MCP endpoint — handshake + gating', () => {
  it('completes a real MCP initialize handshake when agent_checkout is enabled', async () => {
    const { client, transport } = mcpClient(slug);
    // `connect()` performs the real MCP handshake over Streamable HTTP:
    // POST initialize -> POST notifications/initialized. If the store
    // resolver, feature gate, or transport wiring were wrong, this throws.
    await client.connect(transport);

    // Confirms we actually reached THIS store's per-request server (not a
    // generic 200) — buildStoreMcpServer names it `force-store-${slug}`.
    expect(client.getServerVersion()?.name).toBe(`force-store-${slug}`);

    // All 7 tools (catalog + cart + order) are now registered by
    // buildStoreMcpServer — full name-list assertion restored (Task 6).
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

  it('GET /api/v1/mcp/:storeSlug returns 405 (POST-only endpoint)', async () => {
    const res = await fetch(`${API}/mcp/${slug}`, { method: 'GET' });
    expect(res.status).toBe(405);
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
    unknownSlugBody = await res.json();
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
    disabledFeatureBody = await res.json();

    // Restore enabled=true so any later test in this file (or a retry) sees
    // the gate open again.
    await prisma.storeFeature.upsert({
      where: { storeId_featureKey: { storeId, featureKey: 'agent_checkout' } },
      create: { storeId, featureKey: 'agent_checkout', enabled: true },
      update: { enabled: true },
    });
  });

  it('returns a byte-identical 404 body for unknown-slug and feature-disabled (no capability leak)', () => {
    // Both fail-closed paths (resolve-store.ts's slug miss, mcp.routes.ts's
    // feature gate) must be indistinguishable to an external caller — a
    // slug-prober must not be able to tell "store doesn't exist" apart from
    // "store exists but agent_checkout is off/unentitled". Deep-equality on
    // the parsed `error` object (not just status) is the assertion that
    // fails on the old STORE_NOT_FOUND vs NOT_FOUND divergence.
    expect(unknownSlugBody.error).toEqual(disabledFeatureBody.error);
    expect(unknownSlugBody.error.code).toBe('NOT_FOUND');
    expect(unknownSlugBody.error.message).toBe('Not found');
  });

  it('search_products returns matching items; get_product returns detail; get_store_info returns currency', async () => {
    // NOTE: `Product` has NO `currency` column (verified against
    // schema.prisma) — currency is store-level only, surfaced by
    // `get_store_info`/read from `McpStore.currency` inside the tools, not
    // per-product. The task brief's test snippet guessed a `currency` field
    // on `Product.create`; omitted here since it would be an unknown-arg
    // Prisma error.
    const p = await prisma.product.create({
      data: {
        storeId,
        name: 'Blue Widget',
        slug: `blue-${uid()}`,
        status: 'active',
        price: 2500,
        inventory: 5,
      },
    });

    const { client, transport } = mcpClient(slug);
    await client.connect(transport);

    // ≥1 tool is now registered (Task 4), so the server negotiates the
    // `tools` capability and `listTools()` succeeds (unlike the skeleton
    // handshake test above). Only asserts the 3 catalog tools exist here —
    // full 7-name assertion restored in Task 6.
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name)).toEqual(
      expect.arrayContaining(['get_store_info', 'search_products', 'get_product'])
    );

    const search = await client.callTool({
      name: 'search_products',
      arguments: { query: 'Blue', limit: 10 },
    });
    const searchJson = JSON.parse((search.content as any)[0].text);
    expect(searchJson.products.some((x: any) => x.id === p.id)).toBe(true);
    const found = searchJson.products.find((x: any) => x.id === p.id);
    expect(found.title).toBe('Blue Widget');
    expect(found.currency).toBe('EGP');
    expect(found.availability).toBe('in_stock');

    const detail = await client.callTool({ name: 'get_product', arguments: { productId: p.id } });
    const detailJson = JSON.parse((detail.content as any)[0].text);
    expect(detailJson.id).toBe(p.id);
    expect(detailJson.price).toBe(2500);
    expect(detailJson.currency).toBe('EGP');

    const info = await client.callTool({ name: 'get_store_info', arguments: {} });
    expect(JSON.parse((info.content as any)[0].text).currency).toBe('EGP');

    const missing = await client.callTool({
      name: 'get_product',
      arguments: { productId: 'no-such-id' },
    });
    // A thrown AppError (404) is converted by the SDK into an MCP tool
    // error result, not a transport-level failure.
    expect(missing.isError).toBe(true);

    await client.close();
    await prisma.product.delete({ where: { id: p.id } }).catch(() => {});
  });

  it('add_to_cart mints a cartId, view_cart reflects it; oversell rejected', async () => {
    const prod = await prisma.product.create({
      data: {
        storeId,
        name: 'Cart Item',
        slug: `ci-${uid()}`,
        status: 'active',
        price: 1000,
        inventory: 2,
      },
    });

    const { client, transport } = mcpClient(slug, agentKeyA);
    await client.connect(transport);

    const add = await client.callTool({
      name: 'add_to_cart',
      arguments: { productId: prod.id, quantity: 1 },
    });
    const addJson = JSON.parse((add.content as any)[0].text);
    expect(addJson.cartId).toMatch(/^sess_[0-9a-f]{32}$/);
    expect(addJson.items.length).toBe(1);
    expect(addJson.items[0].productId).toBe(prod.id);
    expect(addJson.items[0].quantity).toBe(1);
    expect(addJson.items[0].unitPrice).toBe(1000);
    expect(addJson.currency).toBe('EGP');

    const view = await client.callTool({
      name: 'view_cart',
      arguments: { cartId: addJson.cartId },
    });
    const viewJson = JSON.parse((view.content as any)[0].text);
    expect(viewJson.items[0].quantity).toBe(1);
    expect(viewJson.subtotal).toBe(1000);

    const over = await client.callTool({
      name: 'add_to_cart',
      arguments: { cartId: addJson.cartId, productId: prod.id, quantity: 99 },
    });
    expect(over.isError).toBe(true); // INSUFFICIENT_INVENTORY

    await client.close();
    // `cart_items_product_id_fkey` is ON DELETE RESTRICT (not CASCADE, despite
    // the schema.prisma annotation — confirmed against the applied migration
    // SQL), so the cart minted by add_to_cart must be cleaned up BEFORE the
    // product or this delete 500s with a real FK violation (Cart.onDelete for
    // CartItem is the only CASCADE side).
    await prisma.cart.deleteMany({ where: { storeId, sessionId: addJson.cartId } }).catch(() => {});
    await prisma.product.delete({ where: { id: prod.id } }).catch(() => {});
  });

  it('place_order (cod) creates an agent-sourced order; get_order_status reads it with no PII', async () => {
    const prod = await prisma.product.create({
      data: {
        storeId,
        name: 'Order Item',
        slug: `oi-${uid()}`,
        status: 'active',
        price: 3000,
        inventory: 10,
      },
    });
    // Ensure COD is available for the store — place_order's cod branch mirrors
    // POST /payments/create's COD-availability gate (isEnabled, not `enabled`
    // — the real PaymentConfig column name, confirmed against schema.prisma).
    await prisma.paymentConfig.upsert({
      where: { storeId_provider: { storeId, provider: 'cod' } },
      create: { storeId, provider: 'cod', isEnabled: true, isDefault: true },
      update: { isEnabled: true },
    });

    const { client, transport } = mcpClient(slug, agentKeyA);
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

    // Locks in the fix wave 1 atomicity: the total-bump + Payment insert run
    // in one `withTenantContext` transaction, so a successful place_order
    // MUST have left behind exactly one cod_pending Payment row — never an
    // order with a bumped/unbumped total and no Payment to show for it.
    const dbPayment = await prisma.payment.findFirst({ where: { orderId: placedJson.orderId } });
    expect(dbPayment?.status).toBe('cod_pending');
    expect(dbPayment?.provider).toBe('cod');
    expect(dbPayment?.amount).toBe(dbOrder?.total);

    const status = await client.callTool({
      name: 'get_order_status',
      arguments: { orderId: placedJson.orderId },
    });
    const statusJson = JSON.parse((status.content as any)[0].text);
    expect(statusJson.status).toBeTruthy();
    expect(statusJson.source).toBe('agent');
    // No gated-data leak: status must NOT carry customer PII (email/phone/
    // name) or address — explicit allow-list, not a field-by-field omit.
    expect(statusJson).not.toHaveProperty('email');
    expect(statusJson).not.toHaveProperty('customer');
    expect(statusJson).not.toHaveProperty('shippingAddress');
    expect(statusJson).not.toHaveProperty('items');

    await client.close();
    await prisma.payment.deleteMany({ where: { orderId: placedJson.orderId } }).catch(() => {});
    await prisma.orderItem.deleteMany({ where: { orderId: placedJson.orderId } }).catch(() => {});
    await prisma.order.delete({ where: { id: placedJson.orderId } }).catch(() => {});
    await prisma.product.delete({ where: { id: prod.id } }).catch(() => {});
  });

  it('place_order rejects missing required customer fields (same contract as a human guest order)', async () => {
    const prod = await prisma.product.create({
      data: {
        storeId,
        name: 'Order Item 2',
        slug: `oi2-${uid()}`,
        status: 'active',
        price: 3000,
        inventory: 10,
      },
    });
    const { client, transport } = mcpClient(slug, agentKeyA);
    await client.connect(transport);

    const add = await client.callTool({
      name: 'add_to_cart',
      arguments: { productId: prod.id, quantity: 1 },
    });
    const cartId = JSON.parse((add.content as any)[0].text).cartId;

    // No `name`/`address` — fails the tool's zod input schema, which the MCP
    // SDK converts into `{ isError: true }` (validateToolInput's catch in
    // @modelcontextprotocol/sdk/server/mcp.js), not a protocol-level reject.
    const bad = await client.callTool({
      name: 'place_order',
      arguments: { cartId, paymentMethod: 'cod', customer: { phone: '+96550000000' } },
    });
    expect(bad.isError).toBe(true);

    await client.close();
    await prisma.cart.deleteMany({ where: { storeId, sessionId: cartId } }).catch(() => {});
    await prisma.product.delete({ where: { id: prod.id } }).catch(() => {});
  });

  it('place_order (online) errors cleanly with no order created when no provider is configured', async () => {
    const prod = await prisma.product.create({
      data: {
        storeId,
        name: 'Order Item 3',
        slug: `oi3-${uid()}`,
        status: 'active',
        price: 3000,
        inventory: 10,
      },
    });
    // This store has no PaymentConfig row for any online provider (tap/
    // paymob/kashier/fawry) and the test harness sets no provider env
    // vars, so PaymentFactory has nothing to fall back to either —
    // PaymentService.getDefaultProvider(store.id) resolves null.
    const { client, transport } = mcpClient(slug, agentKeyA);
    await client.connect(transport);

    const add = await client.callTool({
      name: 'add_to_cart',
      arguments: { productId: prod.id, quantity: 1 },
    });
    const cartId = JSON.parse((add.content as any)[0].text).cartId;
    const before = await prisma.order.count({ where: { storeId } });

    const placed = await client.callTool({
      name: 'place_order',
      arguments: {
        cartId,
        paymentMethod: 'online',
        customer: { name: 'Sara Ali', address: 'Block 1, Salmiya' },
      },
    });
    expect(placed.isError).toBe(true);

    // No orphan order — the provider is resolved BEFORE OrderService.create
    // runs, so a store with no online provider configured never has an order
    // (with inventory decremented + cart cleared) stranded behind it.
    const after = await prisma.order.count({ where: { storeId } });
    expect(after).toBe(before);

    await client.close();
    await prisma.cart.deleteMany({ where: { storeId, sessionId: cartId } }).catch(() => {});
    await prisma.product.delete({ where: { id: prod.id } }).catch(() => {});
  });
});

describe('MCP endpoint — cross-tenant isolation (storeId scoping)', () => {
  // A completely separate store (own owner, product, COD order) — every
  // read below is attempted through STORE A's endpoint (`slug`, from the
  // outer describe) using STORE B's ids, to lock in that every MCP tool's
  // underlying service call is storeId-scoped and never resolves another
  // tenant's row.
  let storeBId: string;
  let storeBOwnerId: string;
  let slugB: string;
  // Store B mints its OWN agent key — the cross-tenant test presents it to
  // Store A's endpoint and it must not authorise anything there.
  let agentKeyB: string;
  let productB: { id: string };
  let orderBId: string;
  // A cart that is added-to but never checked out, so it keeps its item —
  // the fixture for the view_cart leak check below. (A checked-out cart's
  // items are cleared by OrderService.create, so it can't double as this.)
  let cartBId: string;

  beforeAll(async () => {
    slugB = `mcp-store-b-${uid()}`;
    agentKeyB = `fak_${randomUUID()}`;
    const ownerB = await prisma.user.create({
      data: {
        email: `mcp-owner-b-${uid()}@example.test`,
        passwordHash: 'x',
        firstName: 'C',
        lastName: 'D',
        role: 'store_admin',
        emailVerified: true,
      },
    });
    storeBOwnerId = ownerB.id;

    const storeB = await prisma.store.create({
      data: {
        name: 'MCP Store B',
        slug: slugB,
        ownerId: storeBOwnerId,
        plan: 'starter',
        status: 'active',
        currency: 'EGP',
        agentApiKeyRotatedAt: new Date(),
        credentials: { create: { agentApiKey: encryption.encrypt(agentKeyB) } },
      },
    });
    storeBId = storeB.id;

    await prisma.storeFeature.upsert({
      where: { storeId_featureKey: { storeId: storeBId, featureKey: 'agent_checkout' } },
      create: { storeId: storeBId, featureKey: 'agent_checkout', enabled: true },
      update: { enabled: true },
    });

    // Same COD-availability fixture as Store A's COD test — required for
    // Store B's own place_order (cod) call below to succeed.
    await prisma.paymentConfig.upsert({
      where: { storeId_provider: { storeId: storeBId, provider: 'cod' } },
      create: { storeId: storeBId, provider: 'cod', isEnabled: true, isDefault: true },
      update: { isEnabled: true },
    });

    productB = await prisma.product.create({
      data: {
        storeId: storeBId,
        name: 'Store B Secret Widget',
        slug: `store-b-widget-${uid()}`,
        status: 'active',
        price: 4500,
        inventory: 10,
      },
    });

    const { client, transport } = mcpClient(slugB, agentKeyB);
    await client.connect(transport);

    // Cart 1: left un-checked-out on purpose, so it still holds its item —
    // the view_cart cross-tenant target below.
    const addCart = await client.callTool({
      name: 'add_to_cart',
      arguments: { productId: productB.id, quantity: 1 },
    });
    cartBId = JSON.parse((addCart.content as any)[0].text).cartId;

    // Cart 2: used only to place a real COD order via Store B's OWN
    // endpoint (needed for the get_order_status cross-tenant target).
    const addOrderCart = await client.callTool({
      name: 'add_to_cart',
      arguments: { productId: productB.id, quantity: 1 },
    });
    const orderCartId = JSON.parse((addOrderCart.content as any)[0].text).cartId;

    const placed = await client.callTool({
      name: 'place_order',
      arguments: {
        cartId: orderCartId,
        paymentMethod: 'cod',
        customer: {
          name: 'Store B Customer',
          phone: '+96550000001',
          address: 'Block 9, Hawally',
        },
      },
    });
    const placedJson = JSON.parse((placed.content as any)[0].text);
    orderBId = placedJson.orderId;

    await client.close();
  });

  afterAll(async () => {
    // Reverse-dependency order, same convention as the Store A fixtures
    // above (CartItem's FK to Product is ON DELETE RESTRICT, not CASCADE).
    await prisma.payment.deleteMany({ where: { orderId: orderBId } }).catch(() => {});
    await prisma.orderItem.deleteMany({ where: { orderId: orderBId } }).catch(() => {});
    await prisma.order.delete({ where: { id: orderBId } }).catch(() => {});
    // Two Cart rows can exist with sessionId === cartBId by this point:
    // Store B's real cart, AND the phantom empty cart Store A's endpoint
    // mints (storeId=storeA, sessionId=cartBId) when the view_cart test
    // below resolves it via storeId-scoped getOrCreate. Delete by
    // sessionId alone (no storeId filter) to clean up both.
    await prisma.cart.deleteMany({ where: { sessionId: cartBId } }).catch(() => {});
    await prisma.product.delete({ where: { id: productB.id } }).catch(() => {});
    await prisma.storeFeature.deleteMany({ where: { storeId: storeBId } }).catch(() => {});
    await prisma.store.delete({ where: { id: storeBId } }).catch(() => {});
    await prisma.user.delete({ where: { id: storeBOwnerId } }).catch(() => {});
  });

  it("get_product on Store A's endpoint denies access to Store B's product", async () => {
    const { client, transport } = mcpClient(slug); // Store A's endpoint
    await client.connect(transport);

    const res = await client.callTool({
      name: 'get_product',
      arguments: { productId: productB.id },
    });
    // ProductService.getPublicById(store.id, productId) is storeId-scoped —
    // Store B's product id resolved against Store A's storeId must 404,
    // never return Store B's product detail.
    expect(res.isError).toBe(true);

    await client.close();
  });

  it("get_order_status on Store A's endpoint denies access to Store B's order", async () => {
    const { client, transport } = mcpClient(slug); // Store A's endpoint
    await client.connect(transport);

    const res = await client.callTool({
      name: 'get_order_status',
      arguments: { orderId: orderBId },
    });
    // OrderService.getById(store.id, orderId) is storeId-scoped — Store B's
    // order id resolved against Store A's storeId must 404, never return
    // Store B's order status.
    expect(res.isError).toBe(true);

    await client.close();
  });

  it("view_cart on Store A's endpoint with Store B's cartId returns an empty cart, never Store B's item", async () => {
    const { client, transport } = mcpClient(slug); // Store A's endpoint
    await client.connect(transport);

    const res = await client.callTool({
      name: 'view_cart',
      arguments: { cartId: cartBId },
    });
    // CartService.getOrCreate(store.id, sessionId) is storeId-scoped: the
    // findFirst WHERE storeId=A AND sessionId=cartBId matches nothing (the
    // real cart row has storeId=B), so it mints a brand-new, empty cart for
    // Store A instead of ever resolving Store B's cart — must NOT error and
    // must NOT contain Store B's item.
    expect(res.isError).toBeFalsy();
    const json = JSON.parse((res.content as any)[0].text);
    expect(json.items.length).toBe(0);
    expect(json.items.some((i: any) => i.productId === productB.id)).toBe(false);
    expect(json.subtotal).toBe(0);

    await client.close();
  });
});

/**
 * Agent-write authorisation — Ruling M1 (2026-09-09).
 *
 * The property that matters most here is the NEGATIVE one: enforcement must
 * not reach the reads. All seven tools plus `initialize` and `tools/list` ride
 * ONE `POST /api/v1/mcp/:storeSlug`, so an auth check in the wrong place
 * (Express middleware instead of the tool handler) takes the entire surface
 * dark while `llms.txt` keeps advertising it. That is FM-1, and the first test
 * below is its guard.
 */
describe('MCP endpoint — agent-write authorisation', () => {
  // A second gated store, used only for the "the escape hatch applies to ONE
  // store, not the fleet" assertion. Deliberately NOT store B from the
  // cross-tenant block above, so the two describes stay independent.
  let storeCId: string;
  let storeCOwnerId: string;
  let slugC: string;
  let productAId: string;

  beforeAll(async () => {
    slugC = `mcp-store-c-${uid()}`;
    const ownerC = await prisma.user.create({
      data: {
        email: `mcp-owner-c-${uid()}@example.test`,
        passwordHash: 'x',
        firstName: 'E',
        lastName: 'F',
        role: 'store_admin',
        emailVerified: true,
      },
    });
    storeCOwnerId = ownerC.id;
    const storeC = await prisma.store.create({
      data: {
        name: 'MCP Store C',
        slug: slugC,
        ownerId: storeCOwnerId,
        plan: 'starter',
        status: 'active',
        currency: 'EGP',
      },
    });
    storeCId = storeC.id;
    await prisma.storeFeature.upsert({
      where: { storeId_featureKey: { storeId: storeCId, featureKey: 'agent_checkout' } },
      create: { storeId: storeCId, featureKey: 'agent_checkout', enabled: true },
      update: { enabled: true },
    });

    const productA = await prisma.product.create({
      data: {
        storeId,
        name: 'Auth Fixture Widget',
        slug: `auth-widget-${uid()}`,
        status: 'active',
        price: 1500,
        inventory: 50,
      },
    });
    productAId = productA.id;
    await prisma.paymentConfig.upsert({
      where: { storeId_provider: { storeId, provider: 'cod' } },
      create: { storeId, provider: 'cod', isEnabled: true, isDefault: true },
      update: { isEnabled: true },
    });
  });

  afterAll(async () => {
    await prisma.cart.deleteMany({ where: { storeId } }).catch(() => {});
    await prisma.product.delete({ where: { id: productAId } }).catch(() => {});
    await prisma.storeFeature
      .deleteMany({ where: { storeId, featureKey: 'agent_checkout_open_writes' } })
      .catch(() => {});
    await prisma.storeFeature.deleteMany({ where: { storeId: storeCId } }).catch(() => {});
    await prisma.store.delete({ where: { id: storeCId } }).catch(() => {});
    await prisma.user.delete({ where: { id: storeCOwnerId } }).catch(() => {});
  });

  it('FM-1 GUARD — the handshake, tools/list and EVERY read tool still work with NO credential', async () => {
    const { client, transport } = mcpClient(slug); // no x-agent-key at all
    await client.connect(transport); // initialize + notifications/initialized

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

    const info = await client.callTool({ name: 'get_store_info', arguments: {} });
    expect(info.isError).toBeFalsy();

    const search = await client.callTool({
      name: 'search_products',
      arguments: { query: 'Auth', limit: 5 },
    });
    expect(search.isError).toBeFalsy();

    const detail = await client.callTool({
      name: 'get_product',
      arguments: { productId: productAId },
    });
    expect(detail.isError).toBeFalsy();

    const view = await client.callTool({
      name: 'view_cart',
      arguments: { cartId: `sess_${uid()}` },
    });
    expect(view.isError).toBeFalsy();

    await client.close();
  });

  it('refuses an ANONYMOUS place_order and creates no order, no payment, no inventory movement', async () => {
    const before = await prisma.order.count({ where: { storeId } });
    const stockBefore = await prisma.product.findUnique({
      where: { id: productAId },
      select: { inventory: true },
    });

    const { client, transport } = mcpClient(slug);
    await client.connect(transport);

    const res = await client.callTool({
      name: 'place_order',
      arguments: {
        cartId: `sess_${uid()}`,
        paymentMethod: 'cod',
        customer: { name: 'Anon Agent', address: 'Nowhere' },
      },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('x-agent-key');

    expect(await prisma.order.count({ where: { storeId } })).toBe(before);
    const stockAfter = await prisma.product.findUnique({
      where: { id: productAId },
      select: { inventory: true },
    });
    expect(stockAfter?.inventory).toBe(stockBefore?.inventory);

    await client.close();
  });

  it('refuses an ANONYMOUS add_to_cart and mints no cart', async () => {
    const cartId = `sess_${uid()}`;
    const { client, transport } = mcpClient(slug);
    await client.connect(transport);

    const res = await client.callTool({
      name: 'add_to_cart',
      arguments: { cartId, productId: productAId, quantity: 1 },
    });
    expect(res.isError).toBe(true);

    expect(await prisma.cart.count({ where: { storeId, sessionId: cartId } })).toBe(0);
    await client.close();
  });

  it('records a REFUSED write in audit_logs with ip and user agent', async () => {
    const { client, transport } = mcpClient(slug);
    await client.connect(transport);
    await client.callTool({
      name: 'add_to_cart',
      arguments: { productId: productAId, quantity: 1 },
    });
    await client.close();

    const row = await prisma.auditLog.findFirst({
      where: { storeId, action: 'agent.write.denied' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).not.toBeNull();
    expect(row?.ipAddress).toBeTruthy();
    expect(row?.userAgent).toBeTruthy();
    expect((row?.details as Record<string, unknown> | null)?.tool).toBe('add_to_cart');
  });

  it('permits both write tools with a VALID credential', async () => {
    const { client, transport } = mcpClient(slug, agentKeyA);
    await client.connect(transport);

    const add = await client.callTool({
      name: 'add_to_cart',
      arguments: { productId: productAId, quantity: 1 },
    });
    expect(add.isError).toBeFalsy();
    const cartId = JSON.parse((add.content as any)[0].text).cartId;

    const placed = await client.callTool({
      name: 'place_order',
      arguments: {
        cartId,
        paymentMethod: 'cod',
        customer: { name: 'Keyed Agent', phone: '+96550000002', address: 'Block 3' },
      },
    });
    expect(placed.isError).toBeFalsy();
    const orderId = JSON.parse((placed.content as any)[0].text).orderId;

    await client.close();
    await prisma.payment.deleteMany({ where: { orderId } }).catch(() => {});
    await prisma.orderItem.deleteMany({ where: { orderId } }).catch(() => {});
    await prisma.order.delete({ where: { id: orderId } }).catch(() => {});
  });

  it('refuses a WRONG credential', async () => {
    const { client, transport } = mcpClient(slug, `fak_${randomUUID()}`);
    await client.connect(transport);
    const res = await client.callTool({
      name: 'add_to_cart',
      arguments: { productId: productAId, quantity: 1 },
    });
    expect(res.isError).toBe(true);
    await client.close();
  });

  it("refuses STORE C's credential on STORE A's endpoint (cross-tenant)", async () => {
    const keyC = `fak_${randomUUID()}`;
    await prisma.storeCredential.upsert({
      where: { storeId: storeCId },
      create: { storeId: storeCId, agentApiKey: encryption.encrypt(keyC) },
      update: { agentApiKey: encryption.encrypt(keyC) },
    });

    const { client, transport } = mcpClient(slug, keyC); // C's key, A's endpoint
    await client.connect(transport);
    const res = await client.callTool({
      name: 'add_to_cart',
      arguments: { productId: productAId, quantity: 1 },
    });
    expect(res.isError).toBe(true);
    await client.close();
  });

  it('refuses a REVOKED credential on the very next call', async () => {
    // Revoke, then present the key that worked a moment ago.
    await prisma.storeCredential.update({ where: { storeId }, data: { agentApiKey: null } });
    const { client, transport } = mcpClient(slug, agentKeyA);
    await client.connect(transport);
    const res = await client.callTool({
      name: 'add_to_cart',
      arguments: { productId: productAId, quantity: 1 },
    });
    expect(res.isError).toBe(true);
    await client.close();

    // Restore for any later test / retry.
    await prisma.storeCredential.update({
      where: { storeId },
      data: { agentApiKey: encryption.encrypt(agentKeyA) },
    });
  });

  it('the ESCAPE HATCH disables enforcement for ONE store and not for another', async () => {
    await prisma.storeFeature.upsert({
      where: {
        storeId_featureKey: { storeId, featureKey: 'agent_checkout_open_writes' },
      },
      create: { storeId, featureKey: 'agent_checkout_open_writes', enabled: true },
      update: { enabled: true },
    });

    // Store A: anonymous write now permitted.
    const a = mcpClient(slug);
    await a.client.connect(a.transport);
    const openRes = await a.client.callTool({
      name: 'add_to_cart',
      arguments: { productId: productAId, quantity: 1 },
    });
    expect(openRes.isError).toBeFalsy();
    await a.client.close();

    // Store C: same anonymous write, still refused — the hatch is per store.
    const productC = await prisma.product.create({
      data: {
        storeId: storeCId,
        name: 'C Widget',
        slug: `c-widget-${uid()}`,
        status: 'active',
        price: 1000,
        inventory: 5,
      },
    });
    const c = mcpClient(slugC);
    await c.client.connect(c.transport);
    const stillClosed = await c.client.callTool({
      name: 'add_to_cart',
      arguments: { productId: productC.id, quantity: 1 },
    });
    expect(stillClosed.isError).toBe(true);
    await c.client.close();

    // Turn it back off and prove enforcement returns.
    await prisma.storeFeature.update({
      where: {
        storeId_featureKey: { storeId, featureKey: 'agent_checkout_open_writes' },
      },
      data: { enabled: false },
    });
    const back = mcpClient(slug);
    await back.client.connect(back.transport);
    const reClosed = await back.client.callTool({
      name: 'add_to_cart',
      arguments: { productId: productAId, quantity: 1 },
    });
    expect(reClosed.isError).toBe(true);
    await back.client.close();

    await prisma.cart.deleteMany({ where: { storeId: storeCId } }).catch(() => {});
    await prisma.product.delete({ where: { id: productC.id } }).catch(() => {});
  });
});
