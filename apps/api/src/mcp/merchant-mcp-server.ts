import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpStore } from './resolve-store';
import { registerAdminReadTools } from './tools/admin-read.tools';
import { registerAdminCustomerMarketingReadTools } from './tools/admin-read-customers-marketing.tools';
import { registerAdminWriteTools } from './tools/admin-write.tools';

/**
 * Builds a per-request MCP server for the MERCHANT-ADMIN surface, scoped to a
 * single store.
 *
 * Separate from `buildStoreMcpServer` on purpose, and the separation is the
 * security control, not an organisational preference: the buyer server's
 * `tools/list` is reachable anonymously, so anything registered there is
 * advertised to the world. Keeping the admin tools on their own server behind
 * a router that rejects before the server is built means an unauthenticated
 * caller never learns these tools exist.
 *
 * Phase 1 registered READ tools only. `admin-write.tools.ts` (2026-10-10)
 * adds the first WRITE tools, gated by their own scope (`merchant:write` /
 * `merchant:destructive`) AND a per-store write switch under `merchant_mcp`
 * itself (`merchant_mcp_write` — see merchant-write.ts); destructive tools
 * additionally require a `confirmToken` round trip. The scope a tool needs
 * stays visible at its registration site, which is why each concern keeps
 * its own registrar rather than one growing file.
 */
export function buildMerchantMcpServer(store: McpStore): McpServer {
  const server = new McpServer({ name: `force-merchant-${store.slug}`, version: '1.0.0' });
  registerAdminReadTools(server, store);
  registerAdminCustomerMarketingReadTools(server, store);
  registerAdminWriteTools(server, store);
  return server;
}
