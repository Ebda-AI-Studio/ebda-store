/**
 * The MERCHANT-ADMIN MCP surface, end to end through the real router.
 *
 * `POST /api/v1/mcp/admin/:storeSlug` lets a merchant operate their own store
 * from Claude Code instead of the admin dashboard. It can read everything the
 * dashboard can, so the properties under test are the boundary itself:
 *
 *  1. **The tool list is invisible without a key.** This is the reason the
 *     surface is a separate router and server rather than more tools on the
 *     buyer endpoint — whose `tools/list` is reachable anonymously by design.
 *     If admin tools were registered there, every anonymous caller would be
 *     told they exist.
 *  2. **Three refusals, one body.** Unknown slug, feature off, and bad key are
 *     byte-identical 404s, so a prober cannot map which stores have the
 *     feature or which keys are real.
 *  3. **Cross-store refusal.** A VALID key for store B is refused on store A.
 *     Every check except the tenant comparison passes in that case, which is
 *     what makes it the one worth an integration test rather than a unit one.
 *  4. **Scopes bite.** A read-only key can call a read tool; the scope check
 *     is not decorative.
 *  5. **Tenant scoping of the data itself.** `admin_get_product` on store A
 *     with store B's product id is refused — the tools inherit the service
 *     layer's scoping rather than re-implementing it.
 *
 * Real Postgres, gated on `hasDb`. Verified against a throwaway postgres:17
 * container before commit; production Neon is never a test target.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { withRlsBypass } from '@ebda/database';
import { AuthService } from '@api/services/auth.service';
import { configureIdentityClient } from '@api/lib/identity-client';
import mcpAdminRoutes from '@api/routes/mcp-admin.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { generateMerchantKey, MERCHANT_SCOPES, MERCHANT_KEY_HEADER } from '@api/mcp/merchant-auth';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const uid = () => `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/mcp/admin', mcpAdminRoutes);
  app.use(errorHandler);
  return app;
}

interface Fixture {
  storeId: string;
  slug: string;
  userId: string;
  productId: string;
  readKey: string;
  noScopeKey: string;
}

async function seedStore(suffix: string, withFeature: boolean): Promise<Fixture> {
  return withRlsBypass(async tx => {
    const owner = await tx.user.create({
      data: {
        email: `merchant-mcp-${suffix}@example.com`,
        passwordHash: 'not-a-real-hash',
        role: 'store_admin',
        firstName: 'Merchant',
        lastName: 'Fixture',
      },
    });
    const store = await tx.store.create({
      data: {
        name: `merchant-mcp ${suffix}`,
        slug: `merchant-mcp-${suffix}`,
        template: 'qamar',
        currency: 'EGP',
        ownerId: owner.id,
        status: 'active',
      },
    });
    if (withFeature) {
      await tx.storeFeature.create({
        data: { storeId: store.id, featureKey: 'merchant_mcp', enabled: true },
      });
    }
    const product = await tx.product.create({
      data: {
        storeId: store.id,
        name: `admin-prod-${suffix}`,
        slug: `admin-prod-${suffix}`,
        price: 12_500,
        inventory: 7,
        trackInventory: true,
        status: 'draft', // draft on purpose: the BUYER surface cannot see this
      },
    });

    const read = generateMerchantKey();
    const none = generateMerchantKey();
    await tx.merchantApiKey.createMany({
      data: [
        {
          storeId: store.id,
          userId: owner.id,
          name: 'read key',
          keyHash: read.hash,
          prefix: read.prefix,
          scopes: [MERCHANT_SCOPES.read],
        },
        {
          storeId: store.id,
          userId: owner.id,
          name: 'no scope key',
          keyHash: none.hash,
          prefix: none.prefix,
          scopes: [],
        },
      ],
    });

    return {
      storeId: store.id,
      slug: store.slug,
      userId: owner.id,
      productId: product.id,
      readKey: read.plaintext,
      noScopeKey: none.plaintext,
    };
  });
}

describe.skipIf(!hasDb)('merchant-admin MCP surface', () => {
  let app: Express;
  let A: Fixture;
  let B: Fixture;
  let gated: Fixture;
  const storeIds: string[] = [];

  beforeAll(async () => {
    app = buildApp();
    A = await seedStore(`a-${uid()}`, true);
    B = await seedStore(`b-${uid()}`, true);
    gated = await seedStore(`g-${uid()}`, false); // merchant_mcp NOT enabled
    storeIds.push(A.storeId, B.storeId, gated.storeId);
  });

  afterAll(async () => {
    await withRlsBypass(tx => tx.store.deleteMany({ where: { id: { in: storeIds } } }));
  });

  /** One MCP JSON-RPC call over the real Streamable HTTP transport. */
  function rpc(slug: string, body: unknown, key?: string) {
    const r = request(app)
      .post(`/api/v1/mcp/admin/${slug}`)
      // The transport requires BOTH; sending only application/json gets a 406
      // from the SDK before any of our code runs.
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json');
    if (key) r.set(MERCHANT_KEY_HEADER, key);
    return r.send(body as object);
  }

  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    },
  };

  it('completes the handshake with a valid key', async () => {
    const res = await rpc(A.slug, initialize, A.readKey);
    expect(res.status).toBe(200);
    expect(res.text).toContain('force-merchant-');
  });

  it('refuses the handshake with NO key — the tool list is never advertised', async () => {
    const res = await rpc(A.slug, initialize);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('admin_');
  });

  it('refuses an unknown slug', async () => {
    const res = await rpc(`no-such-store-${uid()}`, initialize, A.readKey);
    expect(res.status).toBe(404);
  });

  it('refuses a store without the merchant_mcp feature — fail closed', async () => {
    const res = await rpc(gated.slug, initialize, gated.readKey);
    expect(res.status).toBe(404);
  });

  it('gives unknown-slug, feature-off and bad-key a BYTE-IDENTICAL body', async () => {
    const [unknown, off, badKey] = await Promise.all([
      rpc(`no-such-store-${uid()}`, initialize, A.readKey),
      rpc(gated.slug, initialize, gated.readKey),
      rpc(A.slug, initialize, 'ebdam_not-a-real-key-at-all-nope'),
    ]);
    expect(unknown.status).toBe(404);
    expect(off.status).toBe(404);
    expect(badKey.status).toBe(404);
    expect(new Set([unknown.text, off.text, badKey.text]).size).toBe(1);
  });

  it("REFUSES store B's valid key on store A's endpoint", async () => {
    // Every check but the tenant comparison passes for this key.
    const res = await rpc(A.slug, initialize, B.readKey);
    expect(res.status).toBe(404);
  });

  it('lists the admin tools to a key holder', async () => {
    const res = await rpc(
      A.slug,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      A.readKey
    );
    expect(res.status).toBe(200);
    for (const tool of [
      'admin_get_store',
      'admin_list_products',
      'admin_get_product',
      'admin_list_orders',
      'admin_get_order',
      'admin_get_analytics',
    ]) {
      expect(res.text).toContain(tool);
    }
  });

  it('does NOT expose any buyer write tool on this surface', async () => {
    const res = await rpc(
      A.slug,
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      A.readKey
    );
    expect(res.text).not.toContain('place_order');
    expect(res.text).not.toContain('add_to_cart');
  });

  const call = (slug: string, name: string, args: unknown, key?: string) =>
    rpc(
      slug,
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } },
      key
    );

  it('admin_get_store returns this store', async () => {
    const res = await call(A.slug, 'admin_get_store', {}, A.readKey);
    expect(res.status).toBe(200);
    expect(res.text).toContain(A.slug);
  });

  it('admin_list_products sees a DRAFT product the buyer surface cannot', async () => {
    const res = await call(A.slug, 'admin_list_products', {}, A.readKey);
    expect(res.status).toBe(200);
    expect(res.text).toContain(A.productId);
    expect(res.text).toContain('draft');
  });

  it('admin_get_product returns the B0 fields (facts, leadTimeDays, personalisation, sizeChartId)', async () => {
    const chart = await withRlsBypass(async tx => {
      const c = await tx.sizeChart.create({
        data: {
          storeId: A.storeId,
          name: 'mcp chart',
          columns: [{ label: 'Size' }, { label: 'Length' }],
          rows: [['S', '52']],
        },
      });
      await tx.product.update({
        where: { id: A.productId },
        data: {
          facts: [
            { key: 'Fabric', keyAr: 'الخامة', value: 'Linen', valueAr: 'كتان', onCard: true },
          ],
          leadTimeDays: 5,
          personalisation: {
            enabled: true,
            required: true,
            label: 'Name',
            labelAr: 'الاسم',
            maxLength: 12,
          },
          sizeChartId: c.id,
        },
      });
      return c;
    });
    const res = await call(A.slug, 'admin_get_product', { productId: A.productId }, A.readKey);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('isError');
    // The tool result is JSON text inside the JSON-RPC envelope: match the escaped payload.
    const text = res.text.replace(/\\"/g, '"');
    expect(text).toContain('"facts":[{"key":"Fabric","keyAr":"الخامة","value":"Linen"');
    expect(text).toContain('"leadTimeDays":5');
    expect(text).toContain('"personalisation":{');
    expect(text).toContain('"required":true');
    expect(text).toContain('"maxLength":12');
    expect(text).toContain(`"sizeChartId":"${chart.id}"`);
  });

  it("admin_get_product refuses store B's product id on store A", async () => {
    const res = await call(A.slug, 'admin_get_product', { productId: B.productId }, A.readKey);
    expect(res.status).toBe(200); // JSON-RPC transport succeeded...
    expect(res.text).toContain('isError'); // ...and the tool refused.
    expect(res.text).not.toContain(B.slug);
  });

  it('a key with NO scopes is refused by a read tool', async () => {
    const res = await call(A.slug, 'admin_get_store', {}, A.noScopeKey);
    expect(res.text).toContain('FORBIDDEN');
    expect(res.text).toContain('merchant:read');
  });

  it('a revoked key stops working immediately', async () => {
    const fresh = generateMerchantKey();
    await withRlsBypass(tx =>
      tx.merchantApiKey.create({
        data: {
          storeId: A.storeId,
          userId: A.userId,
          name: 'to be revoked',
          keyHash: fresh.hash,
          prefix: fresh.prefix,
          scopes: [MERCHANT_SCOPES.read],
        },
      })
    );
    expect((await rpc(A.slug, initialize, fresh.plaintext)).status).toBe(200);

    await withRlsBypass(tx =>
      tx.merchantApiKey.updateMany({
        where: { keyHash: fresh.hash },
        data: { revokedAt: new Date() },
      })
    );
    expect((await rpc(A.slug, initialize, fresh.plaintext)).status).toBe(404);
  });

  it("a suspended user's key stops working — the dashboard lever reaches the device", async () => {
    const fresh = generateMerchantKey();
    const victim = await withRlsBypass(async tx => {
      const u = await tx.user.create({
        data: {
          email: `suspendable-${uid()}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'staff',
          firstName: 'Sus',
          lastName: 'Pended',
        },
      });
      // Not the owner, so the key is valid only while this staff membership exists (verifyMerchantKey).
      await tx.storeStaff.create({ data: { storeId: A.storeId, userId: u.id } });
      await tx.merchantApiKey.create({
        data: {
          storeId: A.storeId,
          userId: u.id,
          name: 'suspendable key',
          keyHash: fresh.hash,
          prefix: fresh.prefix,
          scopes: [MERCHANT_SCOPES.read],
        },
      });
      return u;
    });

    expect((await rpc(A.slug, initialize, fresh.plaintext)).status).toBe(200);

    await withRlsBypass(tx =>
      tx.user.update({ where: { id: victim.id }, data: { status: 'suspended' } })
    );
    expect((await rpc(A.slug, initialize, fresh.plaintext)).status).toBe(404);

    await withRlsBypass(tx => tx.user.delete({ where: { id: victim.id } }));
  });

  it('revokeAllSessions also kills the merchant key — "all devices" means all', async () => {
    const fresh = generateMerchantKey();
    const owner = await withRlsBypass(async tx => {
      const u = await tx.user.create({
        data: {
          email: `revokable-${uid()}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'staff',
          firstName: 'Rev',
          lastName: 'Oked',
        },
      });
      // Not the owner, so the key is valid only while this staff membership exists (verifyMerchantKey).
      await tx.storeStaff.create({ data: { storeId: A.storeId, userId: u.id } });
      await tx.merchantApiKey.create({
        data: {
          storeId: A.storeId,
          userId: u.id,
          name: 'revokable key',
          keyHash: fresh.hash,
          prefix: fresh.prefix,
          scopes: [MERCHANT_SCOPES.read],
        },
      });
      return u;
    });

    expect((await rpc(A.slug, initialize, fresh.plaintext)).status).toBe(200);

    // `owner` is an admin-namespace account, so revoking its sessions also ends them at the identity service (accounts, not
    // in this tier; its revokeUser is covered by apps/accounts/test/rpc.test.ts): a spy stands in and proves the Store asks.
    const revokeUser = vi.fn(async () => undefined);
    configureIdentityClient({ revokeUser });
    try {
      await AuthService.revokeAllSessions(owner.id);
    } finally {
      configureIdentityClient(undefined);
    }
    expect(revokeUser).toHaveBeenCalledWith(owner.id, expect.any(String));
    expect((await rpc(A.slug, initialize, fresh.plaintext)).status).toBe(404);

    await withRlsBypass(tx => tx.user.delete({ where: { id: owner.id } }));
  });

  it('reports variant-aware stock, not the always-zero products.inventory', async () => {
    // `products.inventory` stays 0 on a variant product. Reading it directly is
    // the defect that filled Low Stock Alerts with well-stocked products, and
    // two shipped skills reason over this field.
    const variantProductId = await withRlsBypass(async tx => {
      const p = await tx.product.create({
        data: {
          storeId: A.storeId,
          name: `variant-prod-${uid()}`,
          slug: `variant-prod-${uid()}`,
          price: 5_000,
          inventory: 0, // the parent row, unused for a variant product
          trackInventory: true,
          hasVariants: true,
          status: 'active',
        },
      });
      await tx.productVariant.createMany({
        data: [
          { productId: p.id, title: 'small', price: 5_000, inventory: 4 },
          { productId: p.id, title: 'large', price: 6_000, inventory: 9 },
        ],
      });
      return p.id;
    });

    const res = await call(A.slug, 'admin_get_product', { productId: variantProductId }, A.readKey);
    expect(res.status).toBe(200);
    const payload = JSON.parse(
      JSON.parse(res.text.slice(res.text.indexOf('{'))).result.content[0].text
    );
    expect(payload.inventory, 'must be the variant sum (13), not the parent 0').toBe(13);
    expect(payload.hasVariants).toBe(true);

    await withRlsBypass(tx => tx.product.delete({ where: { id: variantProductId } }));
  });

  it('GET and DELETE are refused — this transport is POST-only', async () => {
    const get = await request(app).get(`/api/v1/mcp/admin/${A.slug}`);
    const del = await request(app).delete(`/api/v1/mcp/admin/${A.slug}`);
    expect(get.status).toBe(405);
    expect(del.status).toBe(405);
  });
});
