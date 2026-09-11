import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpStore } from './resolve-store';
import { registerAdminReadTools } from './tools/admin-read.tools';

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
 * Phase 1 registers READ tools only. Write tools (phase 2) and destructive
 * tools with `confirm_token` (phase 3) land here as separate registrars, so
 * the scope a tool needs stays visible at its registration site.
 */
export function buildMerchantMcpServer(store: McpStore): McpServer {
  const server = new McpServer({ name: `force-merchant-${store.slug}`, version: '1.0.0' });
  registerAdminReadTools(server, store);
  return server;
}
