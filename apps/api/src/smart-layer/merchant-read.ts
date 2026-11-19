/**
 * The assistant's read tools reuse the Merchant MCP read handlers VERBATIM (Ruling SL-STORE-2: one definition of what a "product" or an "order
 * summary" is, one place that masks e-mails and addresses). Nothing is copied: the handlers are the ones `buildMerchantMcpServer` registers, called
 * in-process through the SDK's in-memory transport with a read-only auth (`merchant:read` only, so even a write tool name could not run).
 * Only the allow-listed names below can be called, each behind the RBAC permission the admin route demands of that role.
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { storeDb } from '../lib/repo-factory';
import { hasPermission, type Permission, type Role } from '../middleware/rbac';
import { buildMerchantMcpServer } from '../mcp/merchant-mcp-server';
import { MERCHANT_SCOPES } from '../mcp/merchant-auth';
import type { McpStore } from '../mcp/resolve-store';

/** Tool -> the permission the admin screen's route demands. A name that is not here cannot be called. */
// pq-allow(unused-export): imported by tests/unit/assistant-adapter.test.ts
export const READ_PERMISSIONS = {
  admin_list_products: 'products:read',
  admin_get_product: 'products:read',
  admin_list_orders: 'orders:read',
  admin_get_order: 'orders:read',
  admin_list_customers: 'orders:read',
  admin_get_customer: 'orders:read',
  admin_get_analytics: 'analytics:read',
  admin_get_funnel: 'store:settings',
} as const satisfies Record<string, Permission>;
export type ReadToolName = keyof typeof READ_PERMISSIONS;

const MERCHANT_ROLES: ReadonlySet<string> = new Set(['store_admin', 'staff', 'super_admin']);

export class ReadForbidden extends Error {
  constructor(readonly tool: string) {
    super(`forbidden: ${tool}`);
    this.name = 'ReadForbidden';
  }
}

/** The store of THIS turn, resolved from its own DO (an id that is not this store's is simply absent: 404, never another store's row). */
async function mcpStore(storeId: string): Promise<McpStore> {
  const row = await (
    await storeDb(storeId)
  ).store.findUnique({
    where: { id: storeId },
    select: { id: true, name: true, slug: true, currency: true, domain: true },
  });
  if (!row) throw new Error('store not found');
  return row as McpStore;
}

export async function callMerchantRead(
  ctx: { storeId: string; userId: string; role: string },
  tool: ReadToolName,
  args: Record<string, unknown>,
  deps: { store?: McpStore } = {}
): Promise<unknown> {
  const need = READ_PERMISSIONS[tool];
  // A merchant role only: a shopper holds `orders:read` for their OWN orders, which is not this surface.
  if (!need || !MERCHANT_ROLES.has(ctx.role) || !hasPermission(ctx.role as Role, need))
    throw new ReadForbidden(tool);
  const store = deps.store ?? (await mcpStore(ctx.storeId));
  if (store.id !== ctx.storeId) throw new ReadForbidden(tool); // never a store other than the turn's own
  const auth: AuthInfo & { keyId: string; userId: string; role: string; storeId: string } = {
    token: 'in-process',
    clientId: 'assistant',
    scopes: [MERCHANT_SCOPES.read],
    keyId: 'assistant',
    userId: ctx.userId,
    role: ctx.role,
    storeId: ctx.storeId,
  };
  const server = buildMerchantMcpServer(store);
  // A one-request transport: the SDK's Client (ajv + schema validators, ~200 KB of bundle) is not needed to ask a server for one tool call.
  let reply!: (m: JSONRPCMessage) => void;
  const answered = new Promise<JSONRPCMessage>(r => (reply = r));
  const transport: Transport = {
    start: async () => undefined,
    close: async () => undefined,
    send: async m => reply(m),
  };
  await server.connect(transport);
  try {
    transport.onmessage?.(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } },
      { authInfo: auth }
    );
    const m = (await answered) as {
      result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      error?: unknown;
    };
    if (m.error || !m.result || m.result.isError) throw new Error('tool refused');
    const text = m.result.content?.find(c => c.type === 'text')?.text ?? '';
    return JSON.parse(text) as unknown;
  } finally {
    await server.close().catch(() => undefined);
  }
}
