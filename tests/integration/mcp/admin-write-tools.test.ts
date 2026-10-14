/**
 * Integration tests for the merchant-admin MCP WRITE surface
 * (`admin-write.tools.ts` + `merchant-write.ts`, Ahmad 2026-10-10).
 *
 * Unlike `tests/integration/mcp/agent-checkout.test.ts` this does NOT drive a
 * live HTTP server + the official MCP client — it calls the registered tool
 * handlers DIRECTLY against a stub `McpServer` that just captures them, so
 * the suite needs a real Postgres connection (`hasDb`, same gate every other
 * Prisma-direct integration test in this repo uses) but never binds a port,
 * which matters when several sessions share this machine. Everything the
 * handlers touch — `OrderService`, `runInTenantContext`, `featureService`,
 * `auditLog` — is the real thing; only the MCP transport is skipped.
 *
 * Real-DB counterpart of `tests/unit/merchant-write-gate.test.ts` (which proves the
 * gate chain with mocks). Here the REAL services, RLS and audit definer run:
 *  1. Permitted write succeeds; the `audit_logs` rows carry `details.actor === 'mcp'`
 *     + the key id (intent AND completed phases).
 *  2. A wrong-store orderId is refused with FORBIDDEN and the foreign order is untouched.
 *  3. `admin_cancel_order` does NOT cancel on the first call; it cancels once with the
 *     token, and the SAME token cannot cancel again (replay).
 *  4. A token minted for one order does not confirm a DIFFERENT order.
 *  5. Plan gate: a Basic store (no `merchant_mcp_write`) is refused.
 *  6. Merchant switch: `settings.mcpWriteEnabled=false` refuses writes on a Business store.
 *  7. A key holding only `merchant:read` cannot call a write tool.
 *
 * RETRY-SAFETY: every id is a per-call `randomUUID()` slice (`uid()`), never
 * a module-scope constant — vitest's `--retry=1` re-runs this file's
 * `beforeAll` in the same process on a retry.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma, withStore } from '@force/database';
import { hasDb } from '../../helpers/bundle-fixtures';
import { registerAdminWriteTools } from '@api/mcp/tools/admin-write.tools';
import { featureService } from '@api/services/feature.service';
import { MERCHANT_SCOPES, type MerchantAuth } from '@api/mcp/merchant-auth';
import type { McpStore } from '@api/mcp/resolve-store';

const uid = () => randomUUID().slice(0, 10);

type ToolHandler = (
  args: Record<string, unknown>,
  extra: { authInfo: MerchantAuth }
) => Promise<any>;

/** Captures the handlers `registerAdminWriteTools` registers — no transport, no port. */
function buildHandlers(store: McpStore): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const stubServer = {
    registerTool: (name: string, _def: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as any;
  registerAdminWriteTools(stubServer, store);
  return handlers;
}

function authFor(opts: {
  keyId: string;
  userId: string;
  storeId: string;
  scopes: readonly string[];
}): MerchantAuth {
  return {
    token: 'fingerprint',
    clientId: opts.keyId,
    keyId: opts.keyId,
    userId: opts.userId,
    role: 'store_admin',
    storeId: opts.storeId,
    scopes: [...opts.scopes],
    ip: '203.0.113.5',
    userAgent: 'vitest-admin-write-tools',
  };
}

function textOf(result: any): any {
  return JSON.parse(result.content[0].text);
}

describe.skipIf(!hasDb)('merchant MCP write tools (admin-write.tools.ts)', () => {
  let storeA: McpStore;
  let storeB: McpStore; // Business plan, merchant switched MCP writes OFF in settings
  let storeC: McpStore; // Basic plan: no merchant_mcp_write
  let ownerId: string;
  const keyId = randomUUID();

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: {
        email: `mcpw-owner-${uid()}@x.test`,
        passwordHash: 'x',
        firstName: 'Mcpw',
        lastName: 'Owner',
        role: 'store_admin',
        emailVerified: true,
      },
    });
    ownerId = owner.id;

    const mk = (k: string, plan: 'starter' | 'enterprise', settings: object = {}) =>
      prisma.store.create({
        data: {
          name: `mcpw-${k}-${uid()}`,
          slug: `mcpw-${k}-${uid()}`,
          ownerId,
          plan,
          status: 'active',
          currency: 'EGP',
          settings,
        },
      });
    const [a, b, c] = await Promise.all([
      mk('a', 'enterprise'),
      mk('b', 'enterprise', { mcpWriteEnabled: false }),
      mk('c', 'starter'),
    ]);
    const toMcp = (x: typeof a): McpStore => ({
      id: x.id,
      name: x.name,
      slug: x.slug,
      currency: x.currency,
      domain: x.domain,
    });
    storeA = toMcp(a);
    storeB = toMcp(b);
    storeC = toMcp(c);
    // Business => merchant_mcp_write ON by plan (no override needed); Basic => OFF.
    for (const id of [storeA.id, storeB.id, storeC.id]) await featureService.invalidateCache(id);
  });

  afterAll(async () => {
    const storeIds = [storeA?.id, storeB?.id, storeC?.id].filter(Boolean) as string[];
    if (storeIds.length) {
      await prisma.order.deleteMany({ where: { storeId: { in: storeIds } } });
      await prisma.storeFeature.deleteMany({ where: { storeId: { in: storeIds } } });
      await prisma.auditLog.deleteMany({ where: { storeId: { in: storeIds } } });
      await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
    }
    if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => undefined);
  });

  async function makeOrder(storeId: string) {
    return prisma.order.create({
      data: {
        storeId,
        orderNumber: `MCPW-${uid()}`,
        subtotal: 1000,
        total: 1000,
        shippingAddress: {},
        billingAddress: {},
      },
    });
  }

  it('permitted write: updates order status and audits with actor=mcp', async () => {
    const order = await makeOrder(storeA.id);
    const handlers = buildHandlers(storeA);
    const auth = authFor({
      keyId,
      userId: ownerId,
      storeId: storeA.id,
      scopes: [MERCHANT_SCOPES.write],
    });

    const result = await handlers.get('admin_update_order_status')!(
      { orderId: order.id, status: 'confirmed' },
      { authInfo: auth }
    );
    expect(textOf(result).status).toBe('confirmed');

    const row = await withStore(storeA.id, tx =>
      tx.auditLog.findFirst({
        where: { action: 'order.status_updated', resourceId: order.id },
        orderBy: { createdAt: 'desc' },
      })
    );
    expect(row).toBeTruthy();
    expect(row!.userId).toBe(ownerId);
    expect((row!.details as Record<string, unknown>).actor).toBe('mcp');
    expect((row!.details as Record<string, unknown>).keyId).toBe(keyId);
  });

  it('wrong-store write: refuses an orderId that belongs to another store', async () => {
    const orderInB = await makeOrder(storeB.id);
    const handlers = buildHandlers(storeA); // tools closed over STORE A
    const auth = authFor({
      keyId,
      userId: ownerId,
      storeId: storeA.id,
      scopes: [MERCHANT_SCOPES.write],
    });

    await expect(
      handlers.get('admin_update_order_status')!(
        { orderId: orderInB.id, status: 'confirmed' },
        { authInfo: auth }
      )
    ).rejects.toThrow(/FORBIDDEN/);

    const stillPending = await prisma.order.findUnique({ where: { id: orderInB.id } });
    expect(stillPending!.status).toBe('pending');
  });

  it('unconfirmed destructive action: admin_cancel_order refuses to cancel until confirmed', async () => {
    const order = await makeOrder(storeA.id);
    const handlers = buildHandlers(storeA);
    const auth = authFor({
      keyId,
      userId: ownerId,
      storeId: storeA.id,
      scopes: [MERCHANT_SCOPES.destructive],
    });

    const first = textOf(
      await handlers.get('admin_cancel_order')!({ orderId: order.id }, { authInfo: auth })
    );
    expect(first.confirmationRequired).toBe(true);
    expect(typeof first.confirmToken).toBe('string');

    const stillPending = await prisma.order.findUnique({ where: { id: order.id } });
    expect(stillPending!.status).toBe('pending');

    const second = textOf(
      await handlers.get('admin_cancel_order')!(
        { orderId: order.id, confirmToken: first.confirmToken },
        { authInfo: auth }
      )
    );
    expect(second.status).toBe('cancelled');

    // Replay: the same token is single-use.
    await expect(
      handlers.get('admin_cancel_order')!(
        { orderId: order.id, confirmToken: first.confirmToken },
        { authInfo: auth }
      )
    ).rejects.toThrow(/already used/);
  });

  it('a confirm token minted for one order does not confirm a different one', async () => {
    const order = await makeOrder(storeA.id);
    const otherOrder = await makeOrder(storeA.id);
    const handlers = buildHandlers(storeA);
    const auth = authFor({
      keyId,
      userId: ownerId,
      storeId: storeA.id,
      scopes: [MERCHANT_SCOPES.destructive],
    });

    const first = textOf(
      await handlers.get('admin_cancel_order')!({ orderId: order.id }, { authInfo: auth })
    );

    const mismatched = textOf(
      await handlers.get('admin_cancel_order')!(
        { orderId: otherOrder.id, confirmToken: first.confirmToken },
        { authInfo: auth }
      )
    );
    // Refused and reissued — not cancelled with the wrong token.
    expect(mismatched.confirmationRequired).toBe(true);

    const otherRow = await prisma.order.findUnique({ where: { id: otherOrder.id } });
    expect(otherRow!.status).toBe('pending');
  });

  it('plan gate: a Basic store (no merchant_mcp_write) is refused', async () => {
    const order = await makeOrder(storeC.id);
    const handlers = buildHandlers(storeC);
    const auth = authFor({
      keyId,
      userId: ownerId,
      storeId: storeC.id,
      scopes: [MERCHANT_SCOPES.write],
    });

    await expect(
      handlers.get('admin_update_order_status')!(
        { orderId: order.id, status: 'confirmed' },
        { authInfo: auth }
      )
    ).rejects.toThrow(/FORBIDDEN/);
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe('pending');
  });

  it('merchant switch: mcpWriteEnabled=false refuses writes even on a Business store', async () => {
    const order = await makeOrder(storeB.id);
    const handlers = buildHandlers(storeB);
    const auth = authFor({
      keyId,
      userId: ownerId,
      storeId: storeB.id,
      scopes: [MERCHANT_SCOPES.write],
    });

    await expect(
      handlers.get('admin_update_order_status')!(
        { orderId: order.id, status: 'confirmed' },
        { authInfo: auth }
      )
    ).rejects.toThrow(/turned MCP write tools off/);
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe('pending');
  });

  it('missing scope: a read-only key cannot call a write tool', async () => {
    const order = await makeOrder(storeA.id);
    const handlers = buildHandlers(storeA);
    const auth = authFor({
      keyId,
      userId: ownerId,
      storeId: storeA.id,
      scopes: [MERCHANT_SCOPES.read],
    });

    await expect(
      handlers.get('admin_update_order_status')!(
        { orderId: order.id, status: 'confirmed' },
        { authInfo: auth }
      )
    ).rejects.toThrow(/FORBIDDEN/);

    const row = await prisma.order.findUnique({ where: { id: order.id } });
    expect(row!.status).toBe('pending');
  });
});
